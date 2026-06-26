import * as fs from 'fs';
import * as path from 'path';
import { CommandHandler, AgentContext } from '../types';
import { AgentError, inferCodeFromMessage } from '../errors';
import { getSetting } from './_shared';

// Browser debugger (Chrome DevTools Protocol) commands — Pro, beta.
//
// These ride the same browser bridge as the g_form commands, but on the browser
// side they route through SNUCdpAdapter (chrome.debugger / CDP) instead of
// content scripts, unlocking what content scripts CANNOT do: network capture,
// console capture, full-page/element screenshots, and native dialog handling.
//
// Gated OFF by default behind `sn-scriptsync.browserDebugger.enabled` (beta, so
// existing setups aren't disrupted): every command short-circuits to
// `E_DISABLED` until the user opts in. On the browser side the adapter is also
// stripped from the SN Utils Community build (`E_CDP_UNAVAILABLE`) and Pro-gated
// (`E_PRO_REQUIRED`). Attaching the debugger shows Chrome's unavoidable yellow
// "started debugging this browser" banner — streaming captures keep it up until
// stopped; one-shot ops (screenshots) detach immediately. Always pair a start_*
// with a stop_* (and a set_dialog_handler with a clear_dialog_handler).

/** True when the user has opted into the browser-debugger beta. */
export function isBrowserDebuggerEnabled(): boolean {
	return getSetting('browserDebugger.enabled', false);
}

// The CDP adapter ships only in this build; the regular SN Utils build reports
// E_CDP_UNAVAILABLE. Surfaced from the VS Code side (here) so the browser
// extension doesn't need a release just to carry the link.
const DEBUG_EDITION_URL = 'https://chromewebstore.google.com/detail/sn-utils-debug/imjkemgdgfakdbobaoagilnoanibajeb';
const CDP_UNAVAILABLE_MESSAGE = `Browser debugger isn't available: the connected SN Utils build has no debugger adapter. Install the SN Utils Debug edition build (${DEBUG_EDITION_URL}); using it also requires an active SN Utils Pro subscription.`;

/**
 * One round-trip of a CDP command through the browser helper. Mirrors
 * browser.ts's pageRoundTrip: surfaces the browser's structured `code` (e.g.
 * E_PRO_REQUIRED, E_CDP_UNAVAILABLE, E_DEBUGGER_BUSY) as an AgentError.
 */
async function cdpRoundTrip(ctx: AgentContext, action: string, extra: Record<string, any>): Promise<any> {
	if (!isBrowserDebuggerEnabled()) {
		throw new AgentError('E_DISABLED', 'Browser debugger (CDP) commands are off by default (beta). Enable sn-scriptsync.browserDebugger.enabled to allow network/console capture, full-page screenshots and dialog handling.');
	}
	const correlationId = `agent_${ctx.request.id}_${Date.now()}`;
	const pending = ctx.waitForBrowserResponse<any>(correlationId);
	ctx.sendToBrowser({ action, agentRequestId: correlationId, appName: 'VS Code', ...extra });
	ctx.log(`Agent API: Sent ${action}`);
	const response = await pending;
	if (response?.success === false) {
		const code = response?.code || inferCodeFromMessage(response?.error);
		if (code === 'E_CDP_UNAVAILABLE') {
			// Point the user at the build that ships the adapter — both in the
			// agent-facing error and as a clickable row in the browser sync log.
			try {
				ctx.sendToBrowser({
					action: 'logMessage',
					source: 'Team SN Utils',
					message: `Browser debugger unavailable: install the <a href="${DEBUG_EDITION_URL}" target="_blank">SN Utils Debug edition</a> build (using it also needs an active SN Utils Pro subscription).`,
				});
			} catch { /* best-effort UI hint */ }
			throw new AgentError('E_CDP_UNAVAILABLE', CDP_UNAVAILABLE_MESSAGE);
		}
		throw new AgentError(code, response?.error || `${action} failed`);
	}
	return response || {};
}

const start_network_capture: CommandHandler = {
	name: 'start_network_capture',
	requiresBrowser: true,
	docs: {
		summary: 'Start recording network requests (with response bodies) on the connected ServiceNow tab via the Chrome debugger (Pro). Pair with stop_network_capture.',
		request: { command: 'start_network_capture', id: 'snc_1', params: { urlFilter: '/api/now', includeBodies: true } },
	},
	async handle(ctx, params) {
		const r = await cdpRoundTrip(ctx, 'agentCdpStartNetworkCapture', {
			urlFilter: params?.urlFilter,
			includeBodies: params?.includeBodies !== false,
			includeTypes: Array.isArray(params?.includeTypes) ? params.includeTypes : undefined,
			maxEntries: params?.maxEntries,
			maxBodyBytes: params?.maxBodyBytes,
			url: params?.url,
			tabId: params?.tabId,
		});
		return { capturing: true, urlFilter: r.urlFilter ?? params?.urlFilter ?? null, includeBodies: r.includeBodies, tabId: r.tabId };
	},
};

const stop_network_capture: CommandHandler = {
	name: 'stop_network_capture',
	requiresBrowser: true,
	docs: {
		summary: 'Stop the network capture started by start_network_capture and return the recorded requests (method, url, status, headers, and response bodies). Detaches the debugger if nothing else is active.',
		request: { command: 'stop_network_capture', id: 'snc_2', params: {} },
	},
	async handle(ctx, params) {
		const r = await cdpRoundTrip(ctx, 'agentCdpStopNetworkCapture', {
			url: params?.url,
			tabId: params?.tabId,
		});
		return { requests: r.requests || [], count: r.count ?? (r.requests ? r.requests.length : 0), tabId: r.tabId };
	},
};

const start_console_capture: CommandHandler = {
	name: 'start_console_capture',
	requiresBrowser: true,
	docs: {
		summary: 'Start capturing console output and uncaught exceptions on the connected ServiceNow tab via the Chrome debugger (Pro). Pair with stop_console_capture.',
		request: { command: 'start_console_capture', id: 'scc_1', params: {} },
	},
	async handle(ctx, params) {
		const r = await cdpRoundTrip(ctx, 'agentCdpStartConsoleCapture', {
			maxEntries: params?.maxEntries,
			url: params?.url,
			tabId: params?.tabId,
		});
		return { capturing: true, tabId: r.tabId };
	},
};

const stop_console_capture: CommandHandler = {
	name: 'stop_console_capture',
	requiresBrowser: true,
	docs: {
		summary: 'Stop the console capture started by start_console_capture and return the collected log entries (level, text, source, and uncaught exceptions).',
		request: { command: 'stop_console_capture', id: 'scc_2', params: {} },
	},
	async handle(ctx, params) {
		const r = await cdpRoundTrip(ctx, 'agentCdpStopConsoleCapture', {
			url: params?.url,
			tabId: params?.tabId,
		});
		return { entries: r.entries || [], count: r.count ?? (r.entries ? r.entries.length : 0), tabId: r.tabId };
	},
};

const capture_full_page: CommandHandler = {
	name: 'capture_full_page',
	requiresBrowser: true,
	docs: {
		summary: 'Capture a full-page (beyond-viewport) or single-element screenshot via the Chrome debugger and save it under screenshots/ (Pro). Unlike take_screenshot (viewport only), this captures the whole scrollable page.',
		request: { command: 'capture_full_page', id: 'cfp_1', params: { fullPage: true } },
	},
	async handle(ctx, params) {
		const workspacePath = ctx.workspaceRoot;
		if (!workspacePath) throw new AgentError('E_INTERNAL', 'No workspace folder open');

		const r = await cdpRoundTrip(ctx, 'agentCdpCaptureScreenshot', {
			fullPage: params?.selector ? false : params?.fullPage !== false,
			selector: params?.selector,
			format: params?.format,
			quality: params?.quality,
			url: params?.url,
			tabId: params?.tabId,
		});

		if (!r.imageData) throw new AgentError('E_INTERNAL', 'No image data received from browser');

		const screenshotsFolder = path.join(workspacePath, 'screenshots');
		if (!fs.existsSync(screenshotsFolder)) fs.mkdirSync(screenshotsFolder, { recursive: true });
		const ext = r.format === 'jpeg' ? 'jpg' : 'png';
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const fileName = params?.fileName || `fullpage_${timestamp}.${ext}`;
		const savePath = path.join(screenshotsFolder, fileName);
		fs.writeFileSync(savePath, new Uint8Array(Buffer.from(r.imageData, 'base64')));
		ctx.log(`Full-page screenshot saved to ${savePath}`);

		return { saved: true, filePath: savePath, fileName, format: r.format || 'png', clip: r.clip || null, tabId: r.tabId };
	},
};

const set_dialog_handler: CommandHandler = {
	name: 'set_dialog_handler',
	requiresBrowser: true,
	docs: {
		summary: 'Install a native-dialog handler on the connected tab via the Chrome debugger (Pro): auto-accept (or dismiss) confirm/alert/prompt/beforeunload and record what was shown. Pair with clear_dialog_handler.',
		request: { command: 'set_dialog_handler', id: 'sdh_1', params: { autoAccept: true } },
	},
	async handle(ctx, params) {
		const r = await cdpRoundTrip(ctx, 'agentCdpSetDialogHandler', {
			autoAccept: params?.autoAccept !== false,
			promptText: params?.promptText,
			url: params?.url,
			tabId: params?.tabId,
		});
		return { handlerActive: true, autoAccept: r.autoAccept ?? (params?.autoAccept !== false), tabId: r.tabId };
	},
};

const clear_dialog_handler: CommandHandler = {
	name: 'clear_dialog_handler',
	requiresBrowser: true,
	docs: {
		summary: 'Remove the native-dialog handler installed by set_dialog_handler and return the dialogs that were intercepted while it was active. Detaches the debugger if nothing else is active.',
		request: { command: 'clear_dialog_handler', id: 'cdh_1', params: {} },
	},
	async handle(ctx, params) {
		const r = await cdpRoundTrip(ctx, 'agentCdpClearDialogHandler', {
			url: params?.url,
			tabId: params?.tabId,
		});
		return { dialogs: r.dialogs || [], count: r.count ?? (r.dialogs ? r.dialogs.length : 0), tabId: r.tabId };
	},
};

const debugger_detach: CommandHandler = {
	name: 'debugger_detach',
	requiresBrowser: true,
	docs: {
		summary: 'Force-detach the Chrome debugger from the connected tab, removing the yellow "started debugging" banner and ending any active capture/handler (Pro). Use as a safety net if a capture was left running.',
		request: { command: 'debugger_detach', id: 'dd_1', params: {} },
	},
	async handle(ctx, params) {
		const r = await cdpRoundTrip(ctx, 'agentCdpDetach', {
			url: params?.url,
			tabId: params?.tabId,
		});
		return { detached: r.detached !== false, tabId: r.tabId };
	},
};

export const cdpCommands: CommandHandler[] = [
	start_network_capture,
	stop_network_capture,
	start_console_capture,
	stop_console_capture,
	capture_full_page,
	set_dialog_handler,
	clear_dialog_handler,
	debugger_detach,
];
