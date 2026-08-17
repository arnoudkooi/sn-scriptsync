import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { AgentRequest, AgentResponse } from './types';
import { AgentError } from './errors';
import { getCommand } from './commands';
import { getSetting } from './commands/_shared';
import { resolveInstanceFolder } from './instanceResolver';
import { buildContext } from './runtime';
import { getCommandPolicy } from './policy';
import { computePayloadHash } from './canonical';
import { registerReview, settleReview } from './reviewRegistry';
import { ExtensionUtils } from '../ExtensionUtils';

const VALID_ID = /^[a-zA-Z0-9_-]+$/;
const eu = new ExtensionUtils();

const GATE_LABELS: Record<string, string> = {
	backgroundScripts: 'Background Scripts',
	deleteRecords: 'Delete Records',
	createArtifacts: 'Create Artifacts',
	restRequest: 'REST write requests',
	browserDebugger: 'Browser Debugger',
};

function errorResponse(id: string, command: string, code: string, message: string, details?: any): AgentResponse {
	return {
		id,
		command,
		status: 'error',
		error: message,
		code: code as any,
		timestamp: Date.now(),
		details,
	};
}

/**
 * Framework entry point. Every transport calls this and nothing
 * else. Evaluates CommandPolicy and Two-Phase Monaco Review.
 */
export async function dispatchAgentCommand(request: AgentRequest): Promise<AgentResponse> {
	if (!request || typeof request !== 'object') {
		return errorResponse('unknown', 'unknown', 'E_INVALID_REQUEST', 'Request must be a JSON object');
	}
	if (!request.id || !request.command) {
		return errorResponse(request?.id || 'unknown', request?.command || 'unknown', 'E_INVALID_REQUEST', 'Missing required fields: id, command');
	}
	if (!VALID_ID.test(request.id)) {
		return errorResponse(request.id, request.command, 'E_SECURITY', 'Invalid request id: only [a-zA-Z0-9_-] allowed');
	}

	const handler = getCommand(request.command);
	if (!handler) {
		return errorResponse(request.id, request.command, 'E_UNKNOWN_COMMAND', `Unknown command: ${request.command}`);
	}

	let instanceFolder: string;
	try {
		instanceFolder = resolveInstanceFolder(request.instance, handler.noInstance);
	} catch (e: any) {
		if (e instanceof AgentError) {
			return errorResponse(request.id, request.command, e.code, e.message);
		}
		console.error('[agent] instance resolution failed:', e?.stack || e);
		return errorResponse(request.id, request.command, 'E_INTERNAL', 'Failed to resolve instance folder');
	}

	const ctx = buildContext(request, instanceFolder);

	if (handler.requiresBrowser) {
		if (!ctx.isServerRunning()) {
			return errorResponse(request.id, request.command, 'E_SERVER_NOT_RUNNING', 'WebSocket server not running. Click sn-scriptsync in VS Code status bar to start.');
		}
		if (!ctx.hasBrowserClient()) {
			return errorResponse(request.id, request.command, 'E_BROWSER_DISCONNECTED', 'No browser connection. Open SN Utils helper tab via /token command.');
		}
	}

	// 1. Command policy and per-instance security gates.
	// A v8 helper (capabilities.instanceSecurityGates) publishes tri-state gates
	// per instance ('off' | 'auto' | 'approve') and owns enforcement: anything it
	// has not explicitly granted is refused (deny-wins). A legacy helper
	// publishes nothing, so the VS Code settings that gated v4.7.9 keep working
	// unchanged as the fallback, and review is skipped because the helper cannot
	// render it (capabilities.commandReview).
	const policy = getCommandPolicy(request);
	const helperBuildInfo = ctx.getHelperBuildInfo ? ctx.getHelperBuildInfo() : null;
	const hasCommandReview = helperBuildInfo?.capabilities?.commandReview === 1;
	const hasInstanceGates = helperBuildInfo?.capabilities?.instanceSecurityGates === 1;

	let instanceSettings: any = null;
	try {
		const instanceName = path.basename(instanceFolder);
		instanceSettings = eu.getInstanceSettings(instanceName);
	} catch {}

	const instanceUrl = instanceSettings?.url || '';
	let instanceOrigin = '';
	try { if (instanceUrl) instanceOrigin = new URL(instanceUrl).origin.toLowerCase(); } catch {}

	const helperGates = (hasInstanceGates && instanceOrigin && ctx.getInstanceGates) ? ctx.getInstanceGates(instanceOrigin) : null;

	let isReviewRequired = policy.review === 'required';
	for (const gateName of policy.gates) {
		const label = GATE_LABELS[gateName] || gateName;
		if (hasInstanceGates) {
			// Deny-wins: only an explicit 'auto' or 'approve' grant passes. 'off',
			// a missing key, and a not-yet-received snapshot all refuse.
			const mode = helperGates ? helperGates[gateName] : undefined;
			if (mode !== 'auto' && mode !== 'approve') {
				return errorResponse(request.id, request.command, 'E_DISABLED',
					`${label} is not allowed for ${instanceOrigin || 'this instance'}. Grant it in the SN Utils helper tab and retry.`);
			}
			if (mode === 'approve') {
				isReviewRequired = true;
			}
		} else {
			// Legacy helper: same VS Code settings and defaults as v4.7.9.
			if (!getSetting<boolean>(`${gateName}.enabled`, gateName === 'createArtifacts')) {
				return errorResponse(request.id, request.command, 'E_DISABLED',
					`${label} is disabled. Enable sn-scriptsync.${gateName}.enabled in VS Code settings, or update SN Utils to grant it per instance in the helper tab.`);
			}
		}
	}
	if (isReviewRequired && helperGates && policy.gates.length > 0 &&
		policy.gates.every((g) => helperGates[g] === 'auto')) {
		// Every governing gate is explicitly 'auto': the user pre-approved this
		// kind of operation for the instance, so skip the review round-trip.
		isReviewRequired = false;
	}

	// 2. Two-phase human review (only when the connected helper can render it).
	if (isReviewRequired && ctx.hasBrowserClient() && hasCommandReview) {
		const correlationId = `agent_${request.id}_${Date.now()}`;
		const reviewId = `rev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
		const serverNonce = crypto.randomBytes(16).toString('hex');
		const payloadHash = computePayloadHash(1, instanceOrigin, request.command, request.params);

		const reviewTimeoutMs = 300_000; // 5 minutes
		const pendingPromise = ctx.waitForBrowserResponse<any>(correlationId, reviewTimeoutMs);

		const extVersion = vscode.extensions.getExtension('arnoudkooi.sn-scriptsync')?.packageJSON?.version || '4.x';

		ctx.sendToBrowser({
			action: 'reviewRequest',
			reviewId,
			nonce: serverNonce,
			payloadHash,
			reviewKind: policy.reviewKind,
			risk: policy.risk,
			command: request.command,
			params: request.params,
			instanceOrigin,
			instance: instanceSettings,
			client: {
				name: 'VS Code Extension',
				version: extVersion,
				hostKind: 'vscode',
				pid: process.pid,
			},
			expiresIn: Math.floor(reviewTimeoutMs / 1000),
			agentRequestId: correlationId,
		});

		// Map the helper tab's review reply onto a final AgentResponse.
		const finalizeReview = async (revResp: any): Promise<AgentResponse> => {
			if (revResp?.success === false) {
				const msg = revResp.error || 'Execution rejected by developer';
				return errorResponse(request.id, request.command, revResp.code || 'E_USER_REJECTED', msg, revResp.details);
			}
			if (revResp?.approvedNotExecuted === true) {
				// The helper approved but cannot run this command shape (bulk
				// delete by query, REST DELETE, delete_application cascade) —
				// execute it here now that the human has signed off.
				try {
					const result = await handler.handle(ctx, request.params || {});
					return { id: request.id, command: request.command, status: 'success', result, timestamp: Date.now() };
				} catch (err: any) {
					if (err instanceof AgentError) {
						return errorResponse(request.id, request.command, err.code, err.message, err.details);
					}
					return errorResponse(request.id, request.command, 'E_INTERNAL', err?.message || String(err));
				}
			}
			// Handled and executed on helper side - return result directly (no double execution!)
			const result = revResp.output !== undefined
				? { output: revResp.output }
				: revResp.data || revResp.result || { success: true };
			return {
				id: request.id,
				command: request.command,
				status: 'success',
				result,
				timestamp: Date.now(),
			};
		};
		const cancelHelperReview = () => {
			try {
				ctx.sendToBrowser({
					action: 'cancelReview',
					reviewId,
					reason: 'COMPLETED_OR_TIMED_OUT',
				});
			} catch {}
		};

		if (request.params?.awaitReview === true) {
			// Legacy blocking mode: hold the transport open until the developer decides.
			try {
				return await finalizeReview(await pendingPromise);
			} catch (err: any) {
				if (err instanceof AgentError) {
					return errorResponse(request.id, request.command, err.code, err.message, err.details);
				}
				return errorResponse(request.id, request.command, 'E_INTERNAL', err?.message || String(err));
			} finally {
				cancelHelperReview();
			}
		}

		// Default: answer immediately so the agent can tell the user to approve,
		// and let get_review_result collect the outcome.
		registerReview(reviewId, request.id, request.command, reviewTimeoutMs);
		pendingPromise
			.then(async (revResp) => settleReview(reviewId, await finalizeReview(revResp)))
			.catch((err: any) => settleReview(reviewId, err instanceof AgentError
				? errorResponse(request.id, request.command, err.code, err.message, err.details)
				: errorResponse(request.id, request.command, 'E_INTERNAL', err?.message || String(err))))
			.finally(cancelHelperReview);

		const expiresInMinutes = Math.floor(reviewTimeoutMs / 60_000);
		return errorResponse(
			request.id,
			request.command,
			'E_REVIEW_PENDING',
			`Human approval required: "${request.command}" is waiting in the SN Utils helper tab Review Queue for ${instanceOrigin || 'the instance'}. ` +
			`Tell the user to approve it there (expires in ${expiresInMinutes} min), then call get_review_result with { reviewId: "${reviewId}" } to collect the outcome.`,
			{ reviewId, expiresInSeconds: Math.floor(reviewTimeoutMs / 1000) },
		);
	}

	// 3. Direct execution (unreviewed commands and the legacy-helper fallback).
	try {
		const result = await handler.handle(ctx, request.params || {});
		return {
			id: request.id,
			command: request.command,
			status: 'success',
			result,
			timestamp: Date.now(),
		};
	} catch (err: any) {
		if (err instanceof AgentError) {
			return errorResponse(request.id, request.command, err.code, err.message, err.details);
		}
		console.error('[agent] command handler failed:', request.command, err?.stack || err);
		return errorResponse(request.id, request.command, 'E_INTERNAL', 'Internal error while handling the command');
	}
}
