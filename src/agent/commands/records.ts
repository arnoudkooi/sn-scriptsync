import * as fs from 'fs';
import * as path from 'path';
import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { ExtensionUtils } from '../../ExtensionUtils';
import { mustGetInstanceSettings, getSetting, restRequest, readBackRecord } from './_shared';

const eu = new ExtensionUtils();

function isCreateArtifactsEnabled(): boolean {
	return getSetting('createArtifacts.enabled', true);
}

function isDeleteRecordsEnabled(): boolean {
	return getSetting('deleteRecords.enabled', false);
}

/** Normalise a Table API field value to a plain string for comparison. */
function normaliseValue(v: any): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'object') return String(v.value ?? '');
	return String(v);
}

/**
 * Compare the fields the agent asked to write against what actually persisted.
 * Only flags fields that came back empty/absent while a non-empty value was
 * requested — this catches silent scope/protected-field drops without the
 * false positives that exact-string comparison would produce for normalised
 * script/HTML content.
 */
function buildDropWarnings(requested: Record<string, any>, persisted: any): string[] {
	const warnings: string[] = [];
	if (!persisted) return warnings;
	for (const [key, val] of Object.entries(requested)) {
		const wanted = normaliseValue(val);
		if (!wanted) continue;
		const got = normaliseValue(persisted[key]);
		if (!got) warnings.push(`Field '${key}' did not persist (came back empty) — likely read-only, protected, or dropped by an ACL/business rule.`);
	}
	return warnings;
}

function pick(obj: any, keys: string[]): Record<string, any> {
	const out: Record<string, any> = {};
	if (!obj) return out;
	for (const k of keys) if (k in obj) out[k] = obj[k];
	return out;
}

const update_record: CommandHandler = {
	name: 'update_record',
	requiresBrowser: true,
	docs: {
		summary: 'Update a single field on an existing record. Fire-and-forget, or set await:true for synchronous read-back confirmation.',
		request: {
			command: 'update_record',
			id: 'upd_1',
			params: { sys_id: '...', table: 'sys_script_include', field: 'script', content: 'gs.info(...)', await: true },
		},
	},
	async handle(ctx, params) {
		const { sys_id, table, field, content } = params || {};
		if (!sys_id || !table || !field || content === undefined) {
			throw new AgentError('E_INVALID_PARAMS', 'Missing required params: sys_id, table, field, content');
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);

		if (params?.await) {
			const { data } = await restRequest(ctx, instanceSettings, {
				endpoint: `/api/now/table/${table}/${sys_id}`,
				method: 'PATCH',
				body: { [field]: content },
			});
			const persisted = data?.result ?? null;
			const warnings = buildDropWarnings({ [field]: content }, persisted);
			ctx.log(`Agent API: Awaited update for ${table}/${sys_id}.${field} (${warnings.length} warning(s))`);
			return { success: true, awaited: true, table, sys_id, field, persisted: pick(persisted, [field]), warnings };
		}

		ctx.sendToBrowser({
			sys_id,
			tableName: table,
			fieldName: field,
			content,
			instance: instanceSettings,
			saveSource: 'AgentAPI-Direct',
		});
		ctx.log(`Agent API: Direct update sent for ${table}/${sys_id}.${field}`);
		return { success: true, message: `Update sent for ${table}/${sys_id}`, table, sys_id, field };
	},
};

const update_record_batch: CommandHandler = {
	name: 'update_record_batch',
	requiresBrowser: true,
	docs: {
		summary: 'Update multiple fields on the same record in one WS roundtrip. Set await:true for synchronous read-back confirmation.',
		request: {
			command: 'update_record_batch',
			id: 'upd_batch_1',
			params: { sys_id: '...', table: 'sp_widget', fields: { script: '...', css: '...' }, await: true },
		},
	},
	async handle(ctx, params) {
		const { sys_id, table, fields } = params || {};
		if (!sys_id || !table || !fields || typeof fields !== 'object') {
			throw new AgentError('E_INVALID_PARAMS', 'Missing required params: sys_id, table, fields (object)');
		}
		const fieldNames = Object.keys(fields);
		if (fieldNames.length === 0) {
			throw new AgentError('E_INVALID_PARAMS', 'Fields object cannot be empty');
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);

		// sys_scope is read-only after insert; writing it silently no-ops. Strip
		// it and surface a warning rather than letting it look like it applied.
		const warnings: string[] = [];
		const writable: Record<string, any> = { ...fields };
		if ('sys_scope' in writable) {
			delete writable.sys_scope;
			warnings.push("Field 'sys_scope' is read-only after insert and was not written. Use create_application/create_artifact to set scope at insert time.");
		}

		if (params?.await) {
			const { data } = await restRequest(ctx, instanceSettings, {
				endpoint: `/api/now/table/${table}/${sys_id}`,
				method: 'PATCH',
				body: writable,
			});
			const persisted = data?.result ?? null;
			warnings.push(...buildDropWarnings(writable, persisted));
			ctx.log(`Agent API: Awaited batch update for ${table}/${sys_id} (${Object.keys(writable).length} fields, ${warnings.length} warning(s))`);
			return { success: true, awaited: true, table, sys_id, fields: Object.keys(writable), persisted: pick(persisted, Object.keys(writable)), warnings };
		}

		ctx.sendToBrowser({
			sys_id,
			tableName: table,
			fields: writable,
			fieldName: Object.keys(writable).join(', '),
			content: '',
			instance: instanceSettings,
			saveSource: 'AgentAPI-Batch',
		});
		ctx.log(`Agent API: Batch update sent for ${table}/${sys_id} (${Object.keys(writable).length} fields)`);
		return { success: true, message: `Updated ${Object.keys(writable).length} field(s) on ${table}/${sys_id}`, table, sys_id, fields: Object.keys(writable), warnings };
	},
};

const create_artifact: CommandHandler = {
	name: 'create_artifact',
	requiresBrowser: true,
	docs: {
		summary: 'Create a new artifact by providing fields directly. Round-trips via the browser. Set await:true to read back persisted values + warnings.',
		request: {
			command: 'create_artifact',
			id: 'cre_1',
			params: { table: 'sys_script_include', scope: 'global', fields: { name: 'MyUtils', script: '...', api_name: 'MyUtils' } },
		},
	},
	async handle(ctx, params) {
		if (!isCreateArtifactsEnabled()) {
			throw new AgentError('E_DISABLED', 'Artifact creation is disabled by setting sn-scriptsync.createArtifacts.enabled');
		}

		const { table, fields } = params || {};
		const scope = params?.scope || 'global';
		if (!table) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: table');
		if (!fields || typeof fields !== 'object') {
			throw new AgentError('E_INVALID_PARAMS', 'Missing required param: fields (object)');
		}
		if (!fields.name) throw new AgentError('E_INVALID_PARAMS', 'Missing required field: name');

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);

		// Resolve scope sys_id via scopes.json
		let scopeSysId: string = scope;
		const scopesPath = path.join(ctx.instanceFolder, 'scopes.json');
		if (scope !== 'global' && fs.existsSync(scopesPath)) {
			try {
				const scopes = JSON.parse(fs.readFileSync(scopesPath, 'utf8'));
				if (scopes[scope]) scopeSysId = scopes[scope];
			} catch { /* ignore */ }
		}

		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'createRecord',
			agentRequestId: correlationId,
			tableName: table,
			instance: instanceSettings,
			scope: scopeSysId,
			payload: { ...fields, sys_scope: scopeSysId },
		});

		ctx.log(`Agent API: Sent create request for ${fields.name} in ${table}`);
		const response = await pending;
		if (response?.success === false) {
			throw new AgentError('E_INTERNAL', response?.error || `Failed to create ${fields.name} in ${table}`);
		}

		const newSysId = response?.newRecord?.sys_id;

		// Update the local _map.json so later queries can resolve by name.
		if (newSysId) {
			const mapPath = path.join(ctx.instanceFolder, scope, table, '_map.json');
			try {
				const nameToSysId = eu.writeOrReadNameToSysIdMapping(mapPath);
				const cleanName = fields.name.replace(/[^a-z0-9\._\-+]+/gi, '').replace(/\./g, '-');
				(nameToSysId as any)[cleanName] = newSysId;
				eu.writeOrReadNameToSysIdMapping(mapPath, nameToSysId);
				ctx.log(`Agent API: Updated _map.json with ${cleanName} -> ${newSysId}`);
			} catch { /* best-effort */ }
		}

		const base = {
			sys_id: newSysId,
			name: response?.newRecord?.name,
			table: response?.newRecord?.tableName,
			scope: response?.newRecord?.scope,
		};

		if (params?.await && newSysId) {
			const requestedFieldNames = Object.keys(fields).join(',');
			const persisted = await readBackRecord(ctx, instanceSettings, table, newSysId, `sys_id,${requestedFieldNames}`);
			const warnings = buildDropWarnings(fields, persisted);
			return { ...base, awaited: true, persisted: pick(persisted, Object.keys(fields)), warnings };
		}

		return base;
	},
};

const get_record: CommandHandler = {
	name: 'get_record',
	requiresBrowser: true,
	docs: {
		summary: 'Fetch a single record by table + sys_id. Cheaper than query_records when you already know the sys_id.',
		request: { command: 'get_record', id: 'get_1', params: { table: 'incident', sys_id: '...', fields: 'number,short_description,state' } },
	},
	async handle(ctx, params) {
		const { table, sys_id, fields } = params || {};
		if (!table || !sys_id) throw new AgentError('E_INVALID_PARAMS', 'Missing required params: table, sys_id');
		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);

		const record = await readBackRecord(ctx, instanceSettings, table, sys_id, fields);
		if (!record) throw new AgentError('E_NOT_FOUND', `No ${table} record with sys_id ${sys_id}`);
		return { table, sys_id, record };
	},
};

const delete_record: CommandHandler = {
	name: 'delete_record',
	requiresBrowser: true,
	docs: {
		summary: 'Delete a record (table + sys_id), or bulk-delete by query with confirm + limit. Guarded by sn-scriptsync.deleteRecords.enabled.',
		request: { command: 'delete_record', id: 'del_1', params: { table: 'incident', sys_id: '...' } },
	},
	async handle(ctx, params) {
		if (!isDeleteRecordsEnabled()) {
			throw new AgentError('E_DISABLED', 'Record deletion is disabled. Enable sn-scriptsync.deleteRecords.enabled to allow it.');
		}

		const table = params?.table;
		const sysId = params?.sys_id;
		const query = params?.query;
		const dryRun = params?.dryRun === true;
		if (!table) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: table');

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const displayFields = 'sys_id,name,number,short_description,sys_class_name';

		// ---- Single delete ----
		if (sysId) {
			const existing = await readBackRecord(ctx, instanceSettings, table, sysId, displayFields);
			if (!existing) throw new AgentError('E_NOT_FOUND', `No ${table} record with sys_id ${sysId}`);
			const display = existing.name || existing.number || existing.short_description || sysId;
			if (dryRun) {
				return { dryRun: true, deleted: false, table, sys_id: sysId, display, message: 'Dry run — record NOT deleted' };
			}
			await restRequest(ctx, instanceSettings, { endpoint: `/api/now/table/${table}/${sysId}`, method: 'DELETE' });
			ctx.log(`Agent API: Deleted ${table}/${sysId} (${display})`);
			return { deleted: true, table, sys_id: sysId, display };
		}

		// ---- Bulk delete (query-based) ----
		if (!query) throw new AgentError('E_INVALID_PARAMS', 'Provide either sys_id (single) or query (bulk)');

		const confirm = params?.confirm === true;
		const limit = Number(params?.limit);
		if (!dryRun && (!confirm || !Number.isInteger(limit) || limit <= 0)) {
			throw new AgentError('E_CONFIRM_REQUIRED', 'Bulk delete requires confirm:true and a positive integer limit. Tip: run with dryRun:true first to preview the matches.');
		}
		const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : 100;

		const { data } = await restRequest(ctx, instanceSettings, {
			endpoint: `/api/now/table/${table}`,
			method: 'GET',
			queryParams: { sysparm_query: query, sysparm_fields: displayFields, sysparm_limit: String(effectiveLimit), sysparm_display_value: 'false' },
		});
		const matches: any[] = data?.result || [];
		const previews = matches.map((r) => ({ sys_id: normaliseSysId(r.sys_id), display: r.name || r.number || r.short_description || normaliseSysId(r.sys_id) }));

		if (dryRun) {
			return { dryRun: true, deleted: false, table, count: previews.length, limit: effectiveLimit, matches: previews, message: `Dry run — ${previews.length} record(s) would be deleted` };
		}

		const results: Array<{ sys_id: string; display: string; deleted: boolean; error?: string }> = [];
		let failures = 0;
		for (const m of previews) {
			try {
				await restRequest(ctx, instanceSettings, { endpoint: `/api/now/table/${table}/${m.sys_id}`, method: 'DELETE' });
				results.push({ sys_id: m.sys_id, display: m.display, deleted: true });
			} catch (e: any) {
				failures++;
				results.push({ sys_id: m.sys_id, display: m.display, deleted: false, error: e?.message || String(e) });
			}
		}
		ctx.log(`Agent API: Bulk delete on ${table} — ${results.length - failures}/${results.length} deleted`);
		if (failures > 0 && failures < results.length) {
			throw new AgentError('E_PARTIAL_FAILURE', `Deleted ${results.length - failures} of ${results.length}; ${failures} failed`, { results });
		}
		return { deleted: failures === 0, table, count: results.length, deletedCount: results.length - failures, results };
	},
};

function normaliseSysId(v: any): string {
	if (v && typeof v === 'object') return String(v.value ?? '');
	return String(v ?? '');
}

const get_table_metadata: CommandHandler = {
	name: 'get_table_metadata',
	requiresBrowser: true,
	docs: {
		summary: 'Fetch column metadata for a table. Round-trips via the browser.',
	},
	async handle(ctx, params) {
		const { table } = params || {};
		if (!table) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: table');
		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);

		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'requestTableStructure',
			agentRequestId: correlationId,
			tableName: table,
			instance: instanceSettings,
		});
		ctx.log(`Agent API: Sent remote request for table metadata: ${table}`);
		const response = await pending;
		return { columns: response?.result?.columns || response?.result };
	},
};

const check_name_exists_remote: CommandHandler = {
	name: 'check_name_exists_remote',
	requiresBrowser: true,
	docs: {
		summary: 'Ask ServiceNow directly whether a record with this name exists.',
	},
	async handle(ctx, params) {
		const { table, name } = params || {};
		if (!table || !name) throw new AgentError('E_INVALID_PARAMS', 'Missing required params: table, name');
		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);

		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'checkNameExists',
			agentRequestId: correlationId,
			tableName: table,
			name,
			instance: instanceSettings,
		});
		ctx.log(`Agent API: Sent remote check for ${name} in ${table}`);
		const response = await pending;
		return {
			exists: response?.exists,
			sysId: response?.existingRecord?.sys_id || null,
			record: response?.existingRecord || null,
		};
	},
};

export const recordsCommands: CommandHandler[] = [
	update_record,
	update_record_batch,
	create_artifact,
	get_record,
	delete_record,
	get_table_metadata,
	check_name_exists_remote,
];
