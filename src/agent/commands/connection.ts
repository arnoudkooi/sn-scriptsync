import * as fs from 'fs';
import * as path from 'path';
import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { ExtensionUtils } from '../../ExtensionUtils';
import { listInstanceFolders } from '../instanceResolver';
import { getSetting } from './_shared';
import { AGENT_API_VERSION } from '../portFile';
import { hasReview, waitForReview, getReviewCommand } from '../reviewRegistry';

const eu = new ExtensionUtils();

const check_connection: CommandHandler = {
	name: 'check_connection',
	noInstance: true,
	docs: {
		summary: 'Verify that the WS server is running and a browser tab is connected, and learn which SN Utils build you are talking to.',
		request: { command: 'check_connection', id: 'chk_1' },
		response: {
			status: 'success',
			result: {
				ready: true,
				serverRunning: true,
				browserConnected: true,
				message: 'Connected and ready',
				helper: { debuggerAvailable: false, tier: 'pro', proFeatures: true },
			},
		},
		notes: '`helper` is the connected SN Utils build\'s self-report: `debuggerAvailable` is true only on the Debug edition (most users run the regular build). Screenshots need no planning — take_screenshot auto-routes to the best available path — but explicit debugger commands (capture_full_page, network/console capture, dialogs) return E_CDP_UNAVAILABLE without the Debug edition. `helper` is null when the handshake has not arrived; `tier`/`proFeatures` may lag the build info by a moment. get_capabilities remains the authoritative, browser-verified view.',
	},
	async handle(ctx) {
		const serverRunning = ctx.isServerRunning();
		const browserConnected = serverRunning && ctx.hasBrowserClient();

		if (!serverRunning) {
			return {
				ready: false,
				serverRunning: false,
				browserConnected: false,
				message: 'WebSocket server not running. Click sn-scriptsync in VS Code status bar to start.',
			};
		}
		if (!browserConnected) {
			return {
				ready: false,
				serverRunning: true,
				browserConnected: false,
				message: 'No browser connected - open helper tab with /token',
			};
		}
		const helper = ctx.getHelperBuildInfo();
		return {
			ready: true,
			serverRunning: true,
			browserConnected: true,
			message: 'Connected and ready',
			// Which SN Utils build is on the other end — lets an agent pick the
			// right capture strategy up front instead of discovering it via errors.
			helper: helper
				? {
					debuggerAvailable: !!helper.debuggerAvailable,
					tier: helper.tier ?? null,
					proFeatures: !!helper.proFeatures,
				}
				: null,
		};
	},
};

const get_sync_status: CommandHandler = {
	name: 'get_sync_status',
	noInstance: true,
	docs: {
		summary: 'Inspect the extension-wide pending-file queue.',
		response: { status: 'success', result: { serverRunning: true, pendingFiles: [], pendingCount: 0, isPaused: false } },
	},
	async handle(ctx) {
		// The queue state lives in extension.ts. The runtime exposes it via the
		// syncState shim to keep this module host-agnostic.
		const state = getSyncState();
		return {
			serverRunning: ctx.isServerRunning(),
			pendingFiles: state.pendingFiles,
			pendingCount: state.pendingFiles.length,
			isPaused: state.isPaused,
		};
	},
};

const get_last_error: CommandHandler = {
	name: 'get_last_error',
	docs: {
		summary: 'Read the last remote sync error (written by the WS bridge).',
	},
	async handle(ctx) {
		const errorFile = path.join(ctx.instanceFolder, '_last_error.json');
		if (!fs.existsSync(errorFile)) {
			return { hasError: false, message: 'No errors recorded' };
		}
		try {
			const data = JSON.parse(fs.readFileSync(errorFile, 'utf8'));
			const isRecent = data.timestamp && Date.now() - data.timestamp < 60_000;
			return {
				hasError: true,
				isRecent,
				error: data.error,
				time: data.time,
				timestamp: data.timestamp,
				details: data.details,
			};
		} catch {
			return { hasError: false, message: 'No recent errors' };
		}
	},
};

const clear_last_error: CommandHandler = {
	name: 'clear_last_error',
	docs: {
		summary: 'Delete _last_error.json for the resolved instance.',
	},
	async handle(ctx) {
		const errorFile = path.join(ctx.instanceFolder, '_last_error.json');
		if (fs.existsSync(errorFile)) {
			fs.unlinkSync(errorFile);
			return { cleared: true, message: 'Error cleared' };
		}
		return { cleared: false, message: 'No error to clear' };
	},
};

const sync_now: CommandHandler = {
	name: 'sync_now',
	noInstance: true,
	docs: {
		summary: 'Flush every pending file in the sync queue immediately. Disabled while review mode (sn-scriptsync.agentApi.reviewWrites) is on — the user approves the queue in VS Code instead.',
	},
	async handle(ctx) {
		const state = getSyncState();
		// Review mode is on: the user signs off on the queue in VS Code (per-file ✓
		// or the Sync Now button). An agent must not be able to flush pending
		// changes itself — otherwise editing a file directly and then calling
		// sync_now bypasses review entirely.
		if (ctx.reviewWritesEnabled()) {
			return {
				synced: false,
				blocked: true,
				count: state.pendingFiles.length,
				files: state.pendingFiles.slice(),
				message: 'Review mode is on (sn-scriptsync.agentApi.reviewWrites): pending changes are held for the user to approve in VS Code (per-file ✓ or the Sync Now button). sync_now is disabled for agents while review is on.',
			};
		}
		if (state.pendingFiles.length === 0) {
			return { synced: false, message: 'No pending files to sync', count: 0 };
		}
		const files = state.pendingFiles.slice();
		const count = files.length;
		state.processPendingFiles();
		return { synced: true, message: `Synced ${count} file(s) immediately`, count, files };
	},
};

// _settings.json is rewritten (refreshing g_ck) every time this instance's
// helper tab talks to the extension, so its mtime is a per-instance freshness
// proxy. Within this window the cached g_ck is almost certainly still valid.
const RECENT_ACTIVITY_WINDOW_MS = 10 * 60 * 60 * 1000; // 10h

const get_instance_info: CommandHandler = {
	name: 'get_instance_info',
	docs: {
		summary: 'Return the resolved instance name, connection flags, and per-instance activity freshness.',
	},
	async handle(ctx) {
		const instanceName = path.basename(ctx.instanceFolder);
		const settings = eu.getInstanceSettings(instanceName);

		// Per-instance freshness from the _settings.json mtime. A single helper
		// tab relays for every instance the browser has a session for, so
		// `connected` (bridge-level) is true for every instance whenever the
		// helper tab is up; `recentlyActive` is the signal that distinguishes
		// the most-recently-active instance.
		let lastActiveAgeMs: number | null = null;
		let recentlyActive = false;
		try {
			const { mtimeMs } = fs.statSync(path.join(ctx.instanceFolder, '_settings.json'));
			lastActiveAgeMs = Math.max(0, Date.now() - mtimeMs);
			recentlyActive = lastActiveAgeMs < RECENT_ACTIVITY_WINDOW_MS;
		} catch {
			// No _settings.json → this instance was never connected.
		}

		return {
			instanceName,
			hasSettings: !!(settings && settings.url),
			// Bridge-level: WS server up + the helper tab connected. NOT
			// exclusive to this instance — the one helper tab relays for many.
			connected: ctx.isServerRunning() && ctx.hasBrowserClient(),
			// Per-instance: was this instance's session refreshed within ~10h?
			recentlyActive,
			lastActiveAgeMs,
		};
	},
};

const list_instances: CommandHandler = {
	name: 'list_instances',
	noInstance: true,
	docs: {
		summary: 'List every instance folder in the workspace with its URL and per-instance activity freshness, plus a suggested default — purely local, no browser round-trip.',
		response: {
			status: 'success',
			result: {
				instances: [
					{ name: 'ven08329', url: 'https://ven08329.service-now.com', recentlyActive: true, lastActiveAgeMs: 425000, hasSettings: true },
				],
				count: 1,
				connected: true,
				defaultInstance: 'ven08329',
				needsConfirmation: false,
			},
		},
	},
	async handle(ctx) {
		const now = Date.now();
		const instances = listInstanceFolders().map((folder) => {
			const name = path.basename(folder);
			const settings = eu.getInstanceSettings(name);
			let lastActiveAgeMs: number | null = null;
			let recentlyActive = false;
			try {
				const { mtimeMs } = fs.statSync(path.join(folder, '_settings.json'));
				lastActiveAgeMs = Math.max(0, now - mtimeMs);
				recentlyActive = lastActiveAgeMs < RECENT_ACTIVITY_WINDOW_MS;
			} catch {
				// No _settings.json mtime → treat as never-active.
			}
			return {
				name,
				url: (settings && settings.url) || null,
				hasSettings: !!(settings && settings.url),
				recentlyActive,
				lastActiveAgeMs,
			};
		});

		// Freshest first; instances that were never active (null age) sink last.
		instances.sort((a, b) => {
			if (a.lastActiveAgeMs == null) return b.lastActiveAgeMs == null ? 0 : 1;
			if (b.lastActiveAgeMs == null) return -1;
			return a.lastActiveAgeMs - b.lastActiveAgeMs;
		});

		// Default only when exactly one instance is recently active; otherwise
		// (none recent, or two-plus recent) the agent should confirm with the user.
		const recent = instances.filter((i) => i.recentlyActive);
		const defaultInstance = recent.length === 1 ? recent[0].name : null;

		return {
			instances,
			count: instances.length,
			connected: ctx.isServerRunning() && ctx.hasBrowserClient(),
			defaultInstance,
			needsConfirmation: recent.length !== 1,
		};
	},
};

const get_capabilities: CommandHandler = {
	name: 'get_capabilities',
	noInstance: true,
	requiresBrowser: true,
	docs: {
		summary: 'Ask the connected SN Utils helper tab what it can do RIGHT NOW: the Agent API version, license tier, whether the Chrome DevTools Protocol browser debugger (network/console capture, full-page screenshots, native dialog handling) is usable, the protocol `capabilities` the helper supports (two-phase command review, per-instance security gates), and the per-instance gate snapshots. Call this once up front to preflight E_DISABLED instead of discovering it mid-operation.',
		request: { command: 'get_capabilities', id: 'cap_1' },
		response: {
			status: 'success',
			result: {
				apiVersion: 8,
				tier: 'pro',
				proFeatures: true,
				cdp: { available: true, reason: null },
				capabilities: { protocolVersion: 1, commandReview: 1, instanceSecurityGates: 1 },
				instanceGates: {
					'https://example.service-now.com': {
						revision: 3,
						gates: { backgroundScripts: 'approve', deleteRecords: 'off', createArtifacts: 'auto', browserDebugger: 'off', restRequest: 'auto' },
					},
				},
			},
		},
		notes: 'Requires a connected helper tab (E_BROWSER_DISCONNECTED otherwise). `cdp.available` is true only when both the CDP adapter is present (Pro build) and the license is Pro/Trial/Enterprise; when false, `cdp.reason` is the code you would have hit (`E_CDP_UNAVAILABLE` for a Community build, `E_PRO_REQUIRED` for a non-Pro license). `capabilities.commandReview: 1` means high-risk commands go through the helper-tab Review Queue (expect E_REVIEW_PENDING, then get_review_result); absent means an older SN Utils build, where high-risk commands run directly and are gated by the sn-scriptsync VS Code settings. `instanceGates` holds the per-instance tri-state grants (`off` refuses, `auto` runs without review, `approve` requires review) keyed by instance origin; a gate that is missing for an instance is treated as `off`.',
	},
	async handle(ctx) {
		const correlationId = `agent_${ctx.request.id}_${Date.now()}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);
		ctx.sendToBrowser({ action: 'agentGetCapabilities', agentRequestId: correlationId, appName: 'VS Code' });
		ctx.log('Agent API: Sent agentGetCapabilities');
		const r = await pending;
		if (r?.success === false) {
			throw new AgentError(r?.code || 'E_INTERNAL', r?.error || 'get_capabilities failed');
		}
		const cdp = r?.cdp || {};
		return {
			apiVersion: AGENT_API_VERSION,
			tier: typeof r?.tier === 'string' ? r.tier : null,
			proFeatures: !!r?.proFeatures,
			cdp: {
				available: !!cdp.available,
				reason: cdp.reason || null,
			},
			capabilities: r?.capabilities || { protocolVersion: 1 },
			instanceGates: r?.instanceGates || {},
		};
	},
};

const get_review_result: CommandHandler = {
	name: 'get_review_result',
	noInstance: true,
	docs: {
		summary: 'Collect the outcome of a pending human review (E_REVIEW_PENDING). Long-polls up to waitSeconds (default 30, max 55); returns the original command\'s result once approved, or its error if rejected/expired.',
		request: { command: 'get_review_result', id: 'revres_1', params: { reviewId: 'rev_...', waitSeconds: 30 } },
	},
	async handle(_ctx, params) {
		const reviewId = params?.reviewId;
		if (!reviewId || typeof reviewId !== 'string') {
			throw new AgentError('E_INVALID_PARAMS', 'Missing required param: reviewId (from the E_REVIEW_PENDING response)');
		}
		if (!hasReview(reviewId)) {
			throw new AgentError('E_NOT_FOUND', 'Unknown or expired reviewId. Settled results are kept ~10 minutes; re-issue the original command to start a new review.');
		}
		const waitSeconds = Math.min(Math.max(Number(params?.waitSeconds) || 30, 0), 55);
		const resp = await waitForReview(reviewId, waitSeconds * 1000);
		if (!resp) {
			throw new AgentError(
				'E_REVIEW_PENDING',
				'Still awaiting developer approval in the SN Utils helper tab Review Queue. Remind the user to approve, then call get_review_result again.',
				{ reviewId },
			);
		}
		if (resp.status === 'error') {
			throw new AgentError((resp.code as any) || 'E_INTERNAL', resp.error || 'Reviewed command failed', resp.details);
		}
		return { reviewId, command: getReviewCommand(reviewId) || resp.command, ...(typeof resp.result === 'object' && resp.result !== null ? resp.result : { result: resp.result }) };
	},
};

export const connectionCommands: CommandHandler[] = [
	check_connection,
	get_sync_status,
	get_last_error,
	clear_last_error,
	sync_now,
	get_instance_info,
	list_instances,
	get_capabilities,
	get_review_result,
];

// ---------------------------------------------------------------------------
// Sync-state shim. extension.ts owns the pendingFiles queue; it registers an
// accessor so command handlers can observe and flush the queue without
// reaching into that file.
// ---------------------------------------------------------------------------
export interface SyncState {
	pendingFiles: string[];
	isPaused: boolean;
	processPendingFiles(): void;
}

let syncStateProvider: () => SyncState = () => ({
	pendingFiles: [],
	isPaused: false,
	processPendingFiles: () => { /* no-op until host wires it up */ },
});

export function setSyncStateProvider(fn: () => SyncState) {
	syncStateProvider = fn;
}

function getSyncState(): SyncState {
	return syncStateProvider();
}
