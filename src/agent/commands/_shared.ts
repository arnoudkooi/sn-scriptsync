// Shared helpers for Agent API command handlers.
//
// Everything ServiceNow-facing in here rides the *existing* browser
// `agentRestApi` passthrough (see scriptsync.js in the SN Utils Pro extension):
// the VS Code side sends `{ action: 'agentRestApi', endpoint, method, body,
// queryParams, instance, agentRequestId }` and the browser replies with
// `{ action: 'agentRestApiResponse', agentRequestId, success, status, data }`.
// The generic `agentRequestId` resolver in extension.ts matches the reply back
// to the pending promise, so no browser changes are needed to add new commands.

import * as path from 'path';
import * as vscode from 'vscode';
import { AgentContext } from '../types';
import { AgentError, AgentErrorCode, inferCodeFromMessage } from '../errors';
import { ExtensionUtils } from '../../ExtensionUtils';

const eu = new ExtensionUtils();

export function mustGetInstanceSettings(instanceFolder: string) {
	const s = eu.getInstanceSettings(path.basename(instanceFolder));
	if (!s || !s.url) {
		throw new AgentError('E_INSTANCE_NOT_FOUND', 'Instance settings not found. Ensure _settings.json exists.');
	}
	return s;
}

export function getSetting<T>(key: string, def: T): T {
	const settings = vscode.workspace.getConfiguration('sn-scriptsync');
	const v = settings.get(key);
	return (v === undefined ? def : v) as T;
}

let restSeq = 0;
function nextCorrelationId(ctx: AgentContext): string {
	restSeq = (restSeq + 1) % 1_000_000;
	return `agent_${ctx.request.id}_${Date.now()}_${restSeq}`;
}

export interface RestOptions {
	endpoint: string;
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	body?: any;
	queryParams?: Record<string, string>;
}

export interface RestResult {
	status: number;
	data: any;
}

/**
 * Round-trip a ServiceNow REST call through the browser helper tab. Throws a
 * structured AgentError when the browser reports `success: false`, mapping a
 * handful of well-known statuses (404/409) onto dedicated codes.
 */
export async function restRequest(ctx: AgentContext, instance: any, opts: RestOptions): Promise<RestResult> {
	const correlationId = nextCorrelationId(ctx);
	const pending = ctx.waitForBrowserResponse<any>(correlationId);

	ctx.sendToBrowser({
		action: 'agentRestApi',
		agentRequestId: correlationId,
		endpoint: opts.endpoint,
		method: opts.method || 'GET',
		body: opts.body,
		queryParams: opts.queryParams,
		instance,
		appName: 'VS Code',
	});

	const response = await pending;
	if (!response || response.success === false) {
		const msg: string = response?.error || 'REST request failed';
		const code: AgentErrorCode = response?.code || codeForRest(response?.status, msg);
		throw new AgentError(code, msg, response?.details || { status: response?.status, detail: response?.detail });
	}
	return { status: response.status, data: response.data };
}

function codeForRest(status: number | undefined, msg: string): AgentErrorCode {
	if (status === 404) return 'E_NOT_FOUND';
	if (status === 409) return 'E_REFERENCE_INTEGRITY';
	if (status === 401 || status === 403) return 'E_ACL';
	// ServiceNow often blocks a delete with a 400 + descriptive message rather
	// than a 409, so fall back to message sniffing for referential integrity.
	const lower = (msg || '').toLowerCase();
	if (lower.includes('cannot delete') || lower.includes('referenc') || lower.includes('cascade')) {
		return 'E_REFERENCE_INTEGRITY';
	}
	return inferCodeFromMessage(msg);
}

/**
 * Run a server-side background script via the browser helper and return its
 * captured output. Round-trips through the `agentRunBackgroundScript` action
 * (which carries the agentRequestId, unlike the fire-and-forget
 * executeBackgroundScript path).
 *
 * `sys.scripts.do` answers a bare "not authorized" when the posted `g_ck` no
 * longer matches the session (reads keep working, so the stored token can go
 * stale unnoticed). That is indistinguishable from a real permissions problem,
 * so on that exact output we refresh the token via the `/token` slash command
 * and retry once before giving up with E_ACL.
 */
export async function runBackgroundScript(ctx: AgentContext, instance: any, script: string): Promise<string> {
	let output = '';
	try {
		output = await postBackgroundScript(ctx, instance, script);
	} catch (e: any) {
		if (e instanceof AgentError && (e.code === 'E_UNAUTHORIZED' || e.code === 'E_ACL' || e.message.toLowerCase().includes('not authorized'))) {
			ctx.log('Agent API: sys.scripts.do reported unauthorized session — attempting token refresh');
			const refreshed = await refreshSessionToken(ctx, instance);
			if (refreshed) {
				ctx.log('Agent API: refreshed session token, retrying background script');
				try {
					return await postBackgroundScript(ctx, refreshed, script);
				} catch (retryErr: any) {
					throw new AgentError(
						'E_UNAUTHORIZED',
						`ServiceNow rejected the background script ("not authorized") even after refreshing the session token. ` +
						`Ensure you are logged into ${instance?.url || 'the instance'} in your browser as an administrator (with elevated 'security_admin' role if required), then run /token from the helper tab.`,
						retryErr?.details,
					);
				}
			}
			throw new AgentError(
				'E_UNAUTHORIZED',
				`ServiceNow rejected the background script ("not authorized"). ` +
				`Please open ${instance?.url || 'the instance'} in your browser, elevate roles to admin/security_admin, and run /token from the helper tab or SN Utils popup.`,
				e?.details,
			);
		}
		throw e;
	}

	if (isNotAuthorized(output)) {
		const refreshed = await refreshSessionToken(ctx, instance);
		if (refreshed) {
			ctx.log('Agent API: sys.scripts.do said "not authorized" — refreshed g_ck, retrying once');
			output = await postBackgroundScript(ctx, refreshed, script);
		}
		if (isNotAuthorized(output)) {
			throw new AgentError(
				'E_UNAUTHORIZED',
				`Instance rejected the background script ("not authorized")${refreshed ? ' even after a session-token refresh' : ' and the session token could not be refreshed'}. ` +
				`Ensure you are logged in to ${instance?.url || 'the instance'} as admin (and elevated security_admin if required), then run /token.`,
			);
		}
	}
	return output;
}

function isNotAuthorized(output: string): boolean {
	return output.trim().toLowerCase() === 'not authorized';
}

async function postBackgroundScript(ctx: AgentContext, instance: any, script: string): Promise<string> {
	const correlationId = nextCorrelationId(ctx);
	const pending = ctx.waitForBrowserResponse<any>(correlationId);
	ctx.sendToBrowser({
		action: 'agentRunBackgroundScript',
		agentRequestId: correlationId,
		script,
		instance,
		appName: 'VS Code',
	});
	const response = await pending;
	if (!response || response.success === false) {
		const msg: string = response?.error || 'Background script failed';
		const code: AgentErrorCode = response?.code || inferCodeFromMessage(msg);
		throw new AgentError(code, msg, response?.details);
	}
	return String(response.output ?? '');
}

/**
 * Ask the helper tab to run `/token` for this instance, then wait for the
 * rewritten `_settings.json` to land a different `g_ck`. Returns the fresh
 * instance settings, or null when no new token shows up in time.
 */
async function refreshSessionToken(ctx: AgentContext, instance: any): Promise<any | null> {
	const oldCk = instance?.g_ck;
	const correlationId = nextCorrelationId(ctx);
	const pending = ctx.waitForBrowserResponse<any>(correlationId);
	ctx.sendToBrowser({
		action: 'runSlashCommand',
		agentRequestId: correlationId,
		command: '/token',
		url: (instance?.url || 'https://*.service-now.com') + '/*',
		autoRun: true,
	});
	try {
		await pending;
	} catch {
		return null;
	}
	const instanceName = path.basename(ctx.instanceFolder);
	for (let i = 0; i < 32; i++) {
		await new Promise((r) => setTimeout(r, 250));
		const fresh = eu.getInstanceSettings(instanceName);
		if (fresh?.g_ck && fresh.g_ck !== oldCk) return fresh;
	}
	return null;
}

/**
 * Fetch a single record by sys_id. Returns the record object, or null when the
 * record does not exist (404). `fields` is a comma-separated sysparm_fields
 * list; omit for all fields.
 */
export async function readBackRecord(
	ctx: AgentContext,
	instance: any,
	table: string,
	sysId: string,
	fields?: string,
): Promise<any | null> {
	const queryParams: Record<string, string> = { sysparm_display_value: 'false' };
	if (fields) queryParams.sysparm_fields = fields;
	try {
		const { data } = await restRequest(ctx, instance, {
			endpoint: `/api/now/table/${table}/${sysId}`,
			method: 'GET',
			queryParams,
		});
		return data?.result ?? null;
	} catch (e) {
		if (e instanceof AgentError && e.code === 'E_NOT_FOUND') return null;
		throw e;
	}
}
