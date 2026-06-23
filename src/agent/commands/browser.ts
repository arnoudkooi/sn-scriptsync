import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../../workspaceRoot';
import { CommandHandler, AgentContext } from '../types';
import { AgentError, inferCodeFromMessage } from '../errors';
import { mustGetInstanceSettings, readBackRecord, restRequest, getSetting } from './_shared';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Look up the authoritative record for a served-URL computation. Prefers the
 * sys_id (exact); otherwise resolves by `nameField` (exact match then a suffix
 * match, which catches an already-prefixed stored name), optionally narrowed by
 * a scope filter so we don't grab a same-named page from a different scope.
 */
async function fetchServedRecord(
	ctx: AgentContext,
	instance: any,
	table: string,
	sysId: string | undefined,
	name: string | undefined,
	nameField: string,
	fields: string,
	scope?: string,
): Promise<any | null> {
	if (sysId) return readBackRecord(ctx, instance, table, sysId, fields);
	if (!name) return null;
	const scopeClause = scope && scope !== 'global' ? `^sys_scope.scope=${scope}` : '';
	for (const q of [`${nameField}=${name}${scopeClause}`, `${nameField}ENDSWITH${name}${scopeClause}`]) {
		try {
			const { data } = await restRequest(ctx, instance, {
				endpoint: `/api/now/table/${table}`,
				method: 'GET',
				queryParams: { sysparm_query: q, sysparm_fields: fields, sysparm_limit: '1', sysparm_display_value: 'false' },
			});
			const rec = data?.result?.[0];
			if (rec) return rec;
		} catch { /* try next match strategy */ }
	}
	return null;
}

/** Read the scope name (e.g. x_acme_app) from a dot-walked record value. */
function scopeOf(rec: any): string | undefined {
	const v = rec?.['sys_scope.scope'];
	if (typeof v === 'string' && v) return v;
	return undefined;
}

/**
 * A scoped UI page named `todo_app` in scope `x_acme_app` is *stored* with
 * name `todo_app` but *served* at `/x_acme_app_todo_app.do`. Prepend the scope
 * unless the name already carries it (guard against double-prefixing).
 */
function applyScopePrefix(name: string, scope?: string): string {
	if (!name || !scope || scope === 'global') return name;
	if (name === scope || name.startsWith(scope + '_')) return name;
	return `${scope}_${name}`;
}

/**
 * Compute the URL a ServiceNow artifact is actually *served* at (not its form).
 * sys_ui_page renders at `<instance>/<scope>_<name>.do` (scope-prefixed at
 * serve time even though the stored name is unprefixed), Service Portal pages
 * at `/sp`, widgets in the preview harness. Falls back to the record form for
 * everything else. This helper exists specifically to hide the scoped
 * double-prefix gotcha.
 */
async function computeServedUrl(
	ctx: AgentContext,
	instance: any,
	opts: { table?: string; sysId?: string; name?: string; scope?: string },
): Promise<string> {
	const base = instance.url;
	const table = opts.table;
	const sysId = opts.sysId;
	const name = opts.name;
	const hintScope = opts.scope && opts.scope !== 'global' ? opts.scope : undefined;

	if (table === 'sp_widget') return `${base}/$sp.do?id=sp-preview&sys_id=${sysId}`;

	if (table === 'sp_page') {
		// Portal pages are served by their `id` field.
		const rec = await fetchServedRecord(ctx, instance, 'sp_page', sysId, name, 'id', 'sys_id,id', hintScope);
		const pageId = rec?.id || name || sysId;
		return `${base}/sp?id=${encodeURIComponent(pageId)}`;
	}

	if (table === 'sys_ui_page') {
		const rec = await fetchServedRecord(ctx, instance, 'sys_ui_page', sysId, name, 'name', 'sys_id,name,sys_scope.scope', hintScope);
		const storedName = rec?.name || name;
		// Prefer the record's real scope; fall back to a caller-provided scope.
		const scopeName = scopeOf(rec) || hintScope;
		const served = applyScopePrefix(storedName || '', scopeName);
		if (served) return `${base}/${encodeURIComponent(served)}.do`;
		return `${base}/sys_ui_page.do?sys_id=${sysId}`;
	}

	return `${base}/${table}.do?sys_id=${sysId}`;
}

/** Resolve a sys_id from name + table + scope via the local _map.json. */
function lookupSysIdFromMap(instanceFolder: string, scope: string, table: string, name: string): string | undefined {
	const mapPath = path.join(instanceFolder, scope, table, '_map.json');
	if (!fs.existsSync(mapPath)) return undefined;
	try {
		const mapContent = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
		const cleanName = name.replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./g, '-');
		return mapContent[cleanName];
	} catch {
		return undefined;
	}
}

const open_in_browser: CommandHandler = {
	name: 'open_in_browser',
	requiresBrowser: true,
	docs: {
		summary: 'Activate (or open) a ServiceNow form/widget/UI-page URL in the connected browser.',
		request: { command: 'open_in_browser', id: 'ob_1', params: { table: 'sys_script_include', sys_id: '...' } },
	},
	async handle(ctx, params) {
		const openTable = params?.table;
		const openScope = params?.scope || 'global';
		const openName = params?.name;
		let sysId = params?.sys_id;

		if (!sysId) {
			if (openName && openTable) {
				sysId = lookupSysIdFromMap(ctx.instanceFolder, openScope, openTable, openName);
			}
			if (!sysId) {
				throw new AgentError('E_INVALID_PARAMS', 'Missing required param: sys_id (or name + table + scope to look it up)');
			}
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const url = await computeServedUrl(ctx, instanceSettings, { table: openTable, sysId, name: openName, scope: openScope });

		const correlationId = `open_${ctx.request.id}_${Date.now()}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'activateTab',
			agentRequestId: correlationId,
			url,
			reload: false,
			waitForLoad: false,
			openIfNotFound: true,
		});
		ctx.log(`Agent API: Sent open_in_browser request for ${url}`);

		const response = await pending;
		return {
			activated: true,
			tabId: response?.tabId,
			url: response?.url || url,
			title: response?.title,
			opened: response?.opened || false,
			reloaded: response?.reloaded || false,
		};
	},
};

const get_served_url: CommandHandler = {
	name: 'get_served_url',
	requiresBrowser: true,
	docs: {
		summary: 'Resolve the served URL for an artifact (UI page .do, portal page, widget preview) without opening it.',
		request: { command: 'get_served_url', id: 'url_1', params: { table: 'sys_ui_page', name: 'my_page' } },
	},
	async handle(ctx, params) {
		const table = params?.table;
		const scope = params?.scope || 'global';
		const name = params?.name;
		let sysId = params?.sys_id;
		if (!table) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: table');
		if (!sysId && name) sysId = lookupSysIdFromMap(ctx.instanceFolder, scope, table, name);
		if (!sysId && !name) throw new AgentError('E_INVALID_PARAMS', 'Provide sys_id, or name (+ scope) to resolve it');

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const url = await computeServedUrl(ctx, instanceSettings, { table, sysId, name, scope });
		return { url, table, sys_id: sysId, name };
	},
};

const refresh_preview: CommandHandler = {
	name: 'refresh_preview',
	requiresBrowser: true,
	docs: {
		summary: 'Tell the browser helper to refresh widget/portal preview tabs. Fire-and-forget.',
	},
	async handle(ctx, params) {
		const table = params?.table;
		const scope = params?.scope || 'global';
		const name = params?.name;
		let sysId = params?.sys_id;

		if (!sysId && name && table) {
			sysId = lookupSysIdFromMap(ctx.instanceFolder, scope, table, name);
		}
		if (!sysId) {
			throw new AgentError('E_INVALID_PARAMS', 'Missing required param: sys_id (or name + table + scope to look it up)');
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);

		const testUrls: string[] = [];
		if (table === 'sp_widget') {
			testUrls.push(`${instanceSettings.url}/$sp.do?id=sp-preview&sys_id=${sysId}*`);
			if (name) {
				const widgetId = name.toLowerCase().replace(/\s+/g, '_');
				testUrls.push(`${instanceSettings.url}/sp_config?id=${widgetId}*`);
				testUrls.push(`${instanceSettings.url}/sp?id=${widgetId}*`);
				testUrls.push(`${instanceSettings.url}/esc?id=${widgetId}*`);
			}
		}

		ctx.sendToBrowser({
			action: 'refreshPreview',
			testUrls,
			sys_id: sysId,
			instance: instanceSettings,
		});
		return {
			refreshed: true,
			sys_id: sysId,
			testUrls,
			message: `Refresh command sent for ${table || 'artifact'}`,
		};
	},
};

/** One round-trip of takeScreenshot. Throws structured errors, never writes. */
async function requestCapture(ctx: AgentContext, opts: { url?: string; tabId?: any; fileName: string; savePath: string; exactUrl?: boolean }) {
	const correlationId = `agent_${ctx.request.id}_${Date.now()}`;
	const pending = ctx.waitForBrowserResponse<any>(correlationId);
	ctx.sendToBrowser({
		action: 'takeScreenshot',
		agentRequestId: correlationId,
		url: opts.url,
		tabId: opts.tabId,
		exactUrl: opts.exactUrl || false,
		fileName: opts.fileName,
		savePath: opts.savePath,
	});
	ctx.log(`Agent API: Sent screenshot request for ${opts.url || `tabId:${opts.tabId}`}`);
	const response = await pending;

	if (response?.code === 'E_SCREENSHOT_PERMISSION') {
		throw new AgentError('E_SCREENSHOT_PERMISSION', response?.error || 'Browser denied the screenshot (tab not capturable / permission).');
	}
	if (response?.success === false) {
		throw new AgentError(inferCodeFromMessage(response?.error), response?.error || 'Screenshot failed');
	}
	if (!response?.imageData) {
		throw new AgentError('E_INTERNAL', 'No image data received from browser');
	}
	return response;
}

/**
 * Shared screenshot capture: round-trips takeScreenshot, writes the PNG, and
 * auto-retries ONCE on a permission error (giving the user a moment to click
 * the extension icon to grant activeTab).
 */
async function captureToFile(ctx: AgentContext, opts: { url?: string; tabId?: any; fileName?: string; exactUrl?: boolean }) {
	const workspacePath = ctx.workspaceRoot;
	if (!workspacePath) throw new AgentError('E_INTERNAL', 'No workspace folder open');

	const screenshotsFolder = path.join(workspacePath, 'screenshots');
	if (!fs.existsSync(screenshotsFolder)) fs.mkdirSync(screenshotsFolder, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const fileName = opts.fileName || `screenshot_${timestamp}.png`;
	const savePath = path.join(screenshotsFolder, fileName);
	const captureOpts = { url: opts.url, tabId: opts.tabId, fileName, savePath, exactUrl: opts.exactUrl };

	let response: any;
	try {
		response = await requestCapture(ctx, captureOpts);
	} catch (e) {
		if (e instanceof AgentError && e.code === 'E_SCREENSHOT_PERMISSION') {
			ctx.log('Agent API: Screenshot permission denied — retrying once in 1.5s');
			await delay(1500);
			response = await requestCapture(ctx, captureOpts);
		} else {
			throw e;
		}
	}

	const imageBuffer = Buffer.from(response.imageData, 'base64');
	fs.writeFileSync(savePath, new Uint8Array(imageBuffer));
	ctx.log(`Screenshot saved to ${savePath}`);

	return {
		saved: true,
		filePath: savePath,
		fileName,
		url: response?.url || opts.url,
		tabId: response?.tabId ?? opts.tabId,
		tabTitle: response?.tabTitle,
	};
}

const take_screenshot: CommandHandler = {
	name: 'take_screenshot',
	requiresBrowser: true,
	docs: {
		summary: 'Capture a screenshot of a ServiceNow URL or tab and save it under screenshots/.',
	},
	async handle(ctx, params) {
		const url = params?.url;
		const tabId = params?.tabId;
		if (!url && !tabId) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: url or tabId');
		return captureToFile(ctx, { url, tabId, fileName: params?.fileName, exactUrl: params?.exactUrl === true });
	},
};

const navigate_and_screenshot: CommandHandler = {
	name: 'navigate_and_screenshot',
	requiresBrowser: true,
	docs: {
		summary: 'Activate/open a URL, wait for it to finish loading, then screenshot that exact tab — removes the activate/sleep/capture dance.',
		request: { command: 'navigate_and_screenshot', id: 'nss_1', params: { url: 'https://dev.service-now.com/incident.do?sys_id=-1', settleMs: 1500 } },
	},
	async handle(ctx, params) {
		const url = params?.url;
		if (!url) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: url');
		const settleMs = Number.isFinite(params?.settleMs) ? Number(params.settleMs) : 1500;

		const correlationId = `nss_${ctx.request.id}_${Date.now()}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);
		ctx.sendToBrowser({
			action: 'activateTab',
			agentRequestId: correlationId,
			url,
			reload: params?.reload || false,
			waitForLoad: true,
			openIfNotFound: true,
		});
		ctx.log(`Agent API: navigate_and_screenshot activating ${url}`);
		const act = await pending;
		const tabId = act?.tabId;

		if (settleMs > 0) await delay(settleMs);

		// We have the exact tabId from the activate round-trip, so target it
		// strictly rather than letting the browser reuse a last-captured tab.
		const shot = await captureToFile(ctx, { url, tabId, fileName: params?.fileName, exactUrl: true });
		return { ...shot, navigated: true, opened: act?.opened || false, reloaded: act?.reloaded || false };
	},
};

const run_slash_command: CommandHandler = {
	name: 'run_slash_command',
	requiresBrowser: true,
	docs: {
		summary: 'Execute an SN Utils slash command in the connected browser helper.',
	},
	async handle(ctx, params) {
		const command = params?.command;
		const url = params?.url || 'https://*.service-now.com/*';
		const tabId = params?.tabId;
		const autoRun = params?.autoRun !== false;

		if (!command) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: command');

		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'runSlashCommand',
			agentRequestId: correlationId,
			command,
			url,
			tabId,
			autoRun,
		});
		ctx.log(`Agent API: Sent slash command request: ${command}`);
		const response = await pending;
		return {
			executed: true,
			slashCommand: response?.command ?? command,
			tabId: response?.tabId,
			autoRun: response?.autoRun ?? autoRun,
		};
	},
};

const activate_tab: CommandHandler = {
	name: 'activate_tab',
	requiresBrowser: true,
	docs: {
		summary: 'Find a browser tab by URL pattern and activate (or open) it.',
	},
	async handle(ctx, params) {
		const url = params?.url;
		if (!url) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: url');

		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'activateTab',
			agentRequestId: correlationId,
			url,
			reload: params?.reload || false,
			waitForLoad: params?.waitForLoad || false,
			openIfNotFound: params?.openIfNotFound || false,
		});
		ctx.log(`Agent API: Sent activate tab request for ${url}`);
		const response = await pending;
		return {
			activated: true,
			tabId: response?.tabId,
			url: response?.url || url,
			title: response?.title,
			opened: response?.opened || false,
			reloaded: response?.reloaded || false,
		};
	},
};

const switch_context: CommandHandler = {
	name: 'switch_context',
	requiresBrowser: true,
	docs: {
		summary: 'Switch the connected browser session to a different update set, application, or domain.',
	},
	async handle(ctx, params) {
		let switchType: string = params?.switchType;
		const value = params?.value || params?.sysId;
		const reloadTab = params?.reloadTab !== false;
		const tabUrl = params?.tabUrl || 'https://*.service-now.com/*';

		if (switchType === 'app') switchType = 'application';
		const validTypes = ['updateset', 'application', 'domain'];
		if (!switchType || !validTypes.includes(switchType)) {
			throw new AgentError('E_INVALID_PARAMS', `Missing or invalid switchType. Must be one of: ${validTypes.join(', ')}`);
		}
		if (!value) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: value (sys_id of update set/app/domain)');

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'switchContext',
			agentRequestId: correlationId,
			switchType,
			value,
			reloadTab,
			tabUrl,
			instance: instanceSettings,
		});
		ctx.log(`Agent API: Sent switch context request - ${switchType}: ${value}`);
		const response = await pending;
		return {
			success: true,
			switchType: response?.switchType ?? switchType,
			value: response?.value ?? value,
			reloaded: response?.reloaded || false,
		};
	},
};

const upload_attachment: CommandHandler = {
	name: 'upload_attachment',
	requiresBrowser: true,
	docs: {
		summary: 'Upload a file from disk or base64 data as an attachment to a ServiceNow record.',
		request: {
			command: 'upload_attachment',
			id: 'ua_1',
			params: { table: 'incident', sys_id: '...', filePath: 'screenshots/latest.png' },
		},
	},
	async handle(ctx, params) {
		const table = params?.table;
		const sysId = params?.sys_id;
		let fileName = params?.fileName;
		let imageData = params?.imageData;
		let contentType = params?.contentType;
		const filePath = params?.filePath;

		if (!table || !sysId) throw new AgentError('E_INVALID_PARAMS', 'Missing required params: table, sys_id');

		if (filePath && !imageData) {
			const resolvedPath = path.isAbsolute(filePath)
				? path.resolve(filePath)
				: path.resolve(ctx.instanceFolder, filePath);
			if (!resolvedPath.startsWith(getWorkspaceRoot() || '')) {
				throw new AgentError('E_SECURITY', 'Security: File path outside workspace not allowed');
			}
			if (!fs.existsSync(resolvedPath)) {
				throw new AgentError('E_INVALID_PARAMS', `File not found: ${resolvedPath}`);
			}
			imageData = fs.readFileSync(resolvedPath, 'base64');
			if (!fileName) fileName = path.basename(resolvedPath);
			if (!contentType) {
				const ext = path.extname(resolvedPath).toLowerCase();
				const mime: Record<string, string> = {
					'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
					'.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
					'.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json',
					'.xml': 'application/xml', '.html': 'text/html', '.css': 'text/css',
					'.js': 'application/javascript', '.zip': 'application/zip',
					'.doc': 'application/msword',
					'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
					'.xls': 'application/vnd.ms-excel',
					'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				};
				contentType = mime[ext] || 'application/octet-stream';
			}
			ctx.log(`Agent API: Read file from ${resolvedPath} (${contentType})`);
		}

		if (!contentType) contentType = 'image/png';
		if (!fileName) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: fileName (or provide filePath)');
		if (!imageData) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: imageData (base64) or filePath');

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'uploadAttachment',
			agentRequestId: correlationId,
			tableName: table,
			recordSysId: sysId,
			fileName,
			imageData,
			contentType,
			instance: instanceSettings,
		});
		ctx.log(`Agent API: Sent upload attachment request for ${fileName} to ${table}/${sysId}`);
		const response = await pending;
		return {
			uploaded: true,
			fileName: response?.fileName ?? fileName,
			table: response?.tableName ?? table,
			recordSysId: response?.recordSysId ?? sysId,
			attachment: response?.attachment,
		};
	},
};

/**
 * Shared round-trip for the live-form/page control family (set_field,
 * get_form_state, run_ui_action, click_element, navigate). The browser side
 * (scriptsync.js -> content_script_parent.js -> inject.js g_form) replies with
 * `{ success, ... }`; failures are surfaced as structured AgentErrors.
 */
async function pageRoundTrip(ctx: AgentContext, action: string, extra: Record<string, any>): Promise<any> {
	const correlationId = `agent_${ctx.request.id}_${Date.now()}`;
	const pending = ctx.waitForBrowserResponse<any>(correlationId);
	ctx.sendToBrowser({ action, agentRequestId: correlationId, ...extra });
	ctx.log(`Agent API: Sent ${action}`);
	const response = await pending;
	if (response?.success === false) {
		throw new AgentError(response?.code || inferCodeFromMessage(response?.error), response?.error || `${action} failed`);
	}
	return response || {};
}

const set_field: CommandHandler = {
	name: 'set_field',
	requiresBrowser: true,
	docs: {
		summary: 'Set a field value on the active ServiceNow form via g_form.setValue (fires client scripts and UI policies — unlike a REST write).',
		request: { command: 'set_field', id: 'sf_1', params: { field: 'short_description', value: 'Network down' } },
	},
	async handle(ctx, params) {
		const field = params?.field;
		if (!field) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: field');
		if (params?.value === undefined) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: value');
		const r = await pageRoundTrip(ctx, 'agentSetField', {
			field,
			value: params.value,
			displayValue: params?.displayValue,
			url: params?.url,
			tabId: params?.tabId,
		});
		return { set: true, field: r.field ?? field, value: r.value, displayValue: r.displayValue };
	},
};

const get_form_state: CommandHandler = {
	name: 'get_form_state',
	requiresBrowser: true,
	docs: {
		summary: 'Read the live form in the connected tab: table, sys_id, new-record flag, and field values (optionally a named subset).',
		request: { command: 'get_form_state', id: 'gfs_1', params: { fields: ['state', 'assigned_to'] } },
	},
	async handle(ctx, params) {
		const r = await pageRoundTrip(ctx, 'agentGetFormState', {
			fields: Array.isArray(params?.fields) ? params.fields : undefined,
			url: params?.url,
			tabId: params?.tabId,
		});
		return { table: r.table, sys_id: r.sysId, isNewRecord: r.isNewRecord, fields: r.fields || {} };
	},
};

const run_ui_action: CommandHandler = {
	name: 'run_ui_action',
	requiresBrowser: true,
	docs: {
		summary: 'Trigger a UI action on the active form: "save", "submit", or a named UI action (sysverb_*). Reloads usually follow.',
		request: { command: 'run_ui_action', id: 'rua_1', params: { uiAction: 'save' } },
	},
	async handle(ctx, params) {
		const uiAction = params?.uiAction || params?.action || 'save';
		// A destructive verb (e.g. sysverb_delete) would, with the confirm() now
		// auto-accepted, silently delete the record — bypassing the guard that
		// gates delete_record / rest_request DELETE / delete_application. Keep
		// deletes consistently behind the same opt-in.
		if (/delete/i.test(uiAction) && !getSetting<boolean>('deleteRecords.enabled', false)) {
			throw new AgentError('E_DISABLED', `run_ui_action '${uiAction}' deletes the record and is disabled. Enable sn-scriptsync.deleteRecords.enabled, or use delete_record.`);
		}
		const r = await pageRoundTrip(ctx, 'agentRunUiAction', {
			uiAction,
			suppressDialogs: params?.suppressDialogs !== false,
			url: params?.url,
			tabId: params?.tabId,
		});
		return { triggered: true, uiAction: r.uiAction ?? uiAction, dialogsSuppressed: r.dialogsSuppressed };
	},
};

const click_element: CommandHandler = {
	name: 'click_element',
	requiresBrowser: true,
	docs: {
		summary: 'Click a DOM element by CSS selector in the ServiceNow content document. Best-effort, light DOM only (no shadow-DOM piercing).',
		request: { command: 'click_element', id: 'ce_1', params: { selector: '#sysverb_update' } },
	},
	async handle(ctx, params) {
		const selector = params?.selector;
		if (!selector) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: selector');
		const r = await pageRoundTrip(ctx, 'agentClickElement', {
			selector,
			suppressDialogs: params?.suppressDialogs !== false,
			url: params?.url,
			tabId: params?.tabId,
		});
		return { clicked: true, selector: r.selector ?? selector, dialogsSuppressed: r.dialogsSuppressed };
	},
};

const navigate: CommandHandler = {
	name: 'navigate',
	requiresBrowser: true,
	docs: {
		summary: 'Navigate a connected ServiceNow tab to a URL (opening one if needed) and resolve once it finishes loading.',
		request: { command: 'navigate', id: 'nav_1', params: { url: 'https://dev123.service-now.com/incident.do?sys_id=-1' } },
	},
	async handle(ctx, params) {
		const url = params?.url;
		if (!url) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: url');
		const r = await pageRoundTrip(ctx, 'agentNavigate', {
			url,
			tabId: params?.tabId,
			newTab: params?.newTab === true,
			waitForLoad: params?.waitForLoad !== false,
			discardUnsaved: params?.discardUnsaved !== false,
		});
		return { navigated: true, tabId: r.tabId, url: r.url || url, title: r.title };
	},
};

export const browserCommands: CommandHandler[] = [
	open_in_browser,
	get_served_url,
	refresh_preview,
	take_screenshot,
	navigate_and_screenshot,
	run_slash_command,
	activate_tab,
	switch_context,
	upload_attachment,
	set_field,
	get_form_state,
	run_ui_action,
	click_element,
	navigate,
];
