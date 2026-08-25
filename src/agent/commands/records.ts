import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { ExtensionUtils } from '../../ExtensionUtils';
import { Constants } from '../../constants';
import { safeJoinUnderRoot, sanitizePathComponent } from '../../pathSafety';
import { mustGetInstanceSettings, getSetting, restRequest, readBackRecord } from './_shared';

const eu = new ExtensionUtils();

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

/** Set by the host when replaying a staged write — skips the review gate so the
 * approved write actually executes. */
function isReviewBypass(params: any): boolean {
	return params?.__review_bypass === true;
}

/** File extension for a preview language, so the review diff highlights + titles nicely. */
function extForLanguage(lang: string): string {
	switch (lang) {
		case 'javascript':
			return 'js';
		case 'scss':
			return 'scss';
		case 'html':
			return 'html';
		case 'json':
			return 'json';
		default:
			return 'txt';
	}
}

/** Best-effort language id for a field's review preview. */
function languageForField(field: string): string {
	switch (field) {
		case 'css':
			return 'scss';
		case 'template':
		case 'html':
			return 'html';
		case 'script':
		case 'client_script':
		case 'server_script':
		case 'processing_script':
		case 'operation_script':
		case 'link':
		case 'calculation':
			return 'javascript';
		default:
			return 'plaintext';
	}
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

		if (ctx.reviewWritesEnabled() && !isReviewBypass(params)) {
			const lang = languageForField(field);
			return ctx.stageWrite({
				label: `update ${table} · ${field}`,
				description: `${table}/${sys_id}`,
				preview: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
				previewLanguage: lang,
				fileName: `${field}.${extForLanguage(lang)}`,
			});
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

		if (ctx.reviewWritesEnabled() && !isReviewBypass(params)) {
			return ctx.stageWrite({
				label: `update ${table} · ${fieldNames.length} field${fieldNames.length !== 1 ? 's' : ''}`,
				description: `${table}/${sys_id} (${fieldNames.join(', ')})`,
				preview: JSON.stringify(fields, null, 2),
				previewLanguage: 'json',
				fileName: 'fields.json',
			});
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
		const { table, fields } = params || {};
		const scope = params?.scope || 'global';
		if (!table) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: table');
		if (!fields || typeof fields !== 'object') {
			throw new AgentError('E_INVALID_PARAMS', 'Missing required param: fields (object)');
		}
		if (!fields.name) throw new AgentError('E_INVALID_PARAMS', 'Missing required field: name');

		if (ctx.reviewWritesEnabled() && !isReviewBypass(params)) {
			return ctx.stageWrite({
				label: `create ${table} · ${fields.name}`,
				description: `${table} in ${scope}`,
				preview: JSON.stringify(fields, null, 2),
				previewLanguage: 'json',
				fileName: `${String(fields.name).replace(/[^a-z0-9._\-+]+/gi, '_')}.json`,
			});
		}

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

const create_record: CommandHandler = {
	name: 'create_record',
	requiresBrowser: true,
	docs: {
		summary: 'Insert a plain data row on any table (incident, task, sys_user, cmdb_ci). Use create_artifact instead for scriptable artifacts, which are also tracked in the local workspace.',
		request: {
			command: 'create_record',
			id: 'crec_1',
			params: { table: 'incident', fields: { short_description: 'Printer on 3rd floor is down', urgency: '2' } },
		},
	},
	async handle(ctx, params) {
		const { table, fields } = params || {};
		if (!table || typeof table !== 'string' || !/^[a-zA-Z0-9_]+$/.test(table.trim())) {
			throw new AgentError('E_INVALID_PARAMS', 'Missing or invalid param "table" (must be alphanumeric/underscore)');
		}
		if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
			throw new AgentError('E_INVALID_PARAMS', 'Missing required param "fields": provide at least one field value for the new record');
		}

		if (ctx.reviewWritesEnabled() && !isReviewBypass(params)) {
			return ctx.stageWrite({
				label: `create ${table}`,
				description: `New row on ${table}`,
				preview: JSON.stringify(fields, null, 2),
				previewLanguage: 'json',
				fileName: `${table}.json`,
			});
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const { data } = await restRequest(ctx, instanceSettings, {
			endpoint: `/api/now/table/${table.trim()}`,
			method: 'POST',
			body: fields,
			queryParams: { sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true' },
		});

		// POST /api/now/table returns the inserted row, so the write is already
		// verified: no follow-up get_record needed.
		const record = data?.result ?? null;
		const readField = (name: string): string => {
			const value = record?.[name];
			if (value && typeof value === 'object') return String(value.value ?? value.display_value ?? '');
			return value === undefined || value === null ? '' : String(value);
		};
		const sys_id = readField('sys_id');
		ctx.log(`Agent API: Created ${table}/${sys_id || '(no sys_id returned)'}`);

		return {
			created: true,
			table,
			sys_id,
			name: readField('number') || readField('name') || readField('sys_name') || readField('short_description'),
			record,
		};
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
		summary: 'Delete a record (table + sys_id), or bulk-delete by query with confirm + limit. Controlled per-instance in the SN Utils helper tab.',
		request: { command: 'delete_record', id: 'del_1', params: { table: 'incident', sys_id: '...' } },
	},
	async handle(ctx, params) {
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

let metaDataRelationsCache: any = null;
function getMetaDataRelations(): any {
	if (!metaDataRelationsCache) {
		try {
			const candidate = path.resolve(__dirname, '..', '..', '..', 'resources', 'metaDataRelations.json');
			if (fs.existsSync(candidate)) {
				metaDataRelationsCache = JSON.parse(fs.readFileSync(candidate, 'utf8'));
			}
		} catch { /* best effort */ }
	}
	return metaDataRelationsCache;
}

function resolveTableCodeFields(tableName: string): string[] {
	const meta = getMetaDataRelations();
	const fields = meta?.tableFields?.[tableName]?.codeFields;
	if (fields && typeof fields === 'object') {
		const keys = Object.keys(fields).filter((k) => !k.startsWith('_'));
		if (keys.length > 0) return keys;
	}
	return ['script'];
}

function resolveFieldExtension(tableName: string, fieldName: string): string {
	const meta = getMetaDataRelations();
	let fieldType = 'script';
	try {
		fieldType = meta?.tableFields?.[tableName]?.codeFields?.[fieldName]?.type || fieldName;
	} catch {}

	let ext = (Constants.FIELDTYPES as any)?.[fieldType]?.extension;
	if (fieldType.includes('xml')) ext = '.xml';
	else if (fieldType.includes('html')) ext = '.html';
	else if (fieldType.includes('json')) ext = '.json';
	else if (fieldType.includes('css') || fieldType === 'properties' || fieldName === 'css') ext = '.scss';
	else if (fieldType.includes('string') || fieldType === 'conditions') ext = '.txt';
	else if (fieldType.includes('graphql')) ext = '.graphql';
	else if (!ext) ext = '.js';

	return ext;
}

const pull_records: CommandHandler = {
	name: 'pull_records',
	requiresBrowser: true,
	docs: {
		summary: 'Pull records from ServiceNow and store code fields into canonical local files with _map.json tracking.',
		request: {
			command: 'pull_records',
			id: 'pull_1',
			params: { table: 'sys_script_include', query: 'active=true^nameSTARTSWITHincident', limit: 10, openFiles: false },
		},
	},
	async handle(ctx, params) {
		const rawTable = params?.table;
		if (!rawTable || typeof rawTable !== 'string' || !/^[a-zA-Z0-9_]+$/.test(rawTable.trim())) {
			throw new AgentError('E_INVALID_PARAMS', 'Missing or invalid required param "table" (must be alphanumeric/underscore)');
		}
		const table = rawTable.trim();

		let limit = 50;
		if (params?.limit !== undefined) {
			if (typeof params.limit !== 'number' || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 500) {
				throw new AgentError('E_INVALID_PARAMS', 'Parameter "limit" must be an integer between 1 and 500.');
			}
			limit = params.limit;
		}

		const openFiles = params?.openFiles === true;

		// Normalize & validate sys_ids
		const rawIds: string[] = [];
		if (typeof params?.sys_id === 'string' && params.sys_id.trim()) {
			rawIds.push(params.sys_id.trim());
		}
		if (Array.isArray(params?.sys_ids)) {
			for (const id of params.sys_ids) {
				if (typeof id === 'string' && id.trim()) rawIds.push(id.trim());
			}
		}
		const validHexOrGlobal = /^(?:[0-9a-fA-F]{32}|global)$/;
		const normalizedIds = Array.from(new Set(rawIds.map((id) => id.toLowerCase())));
		for (const id of normalizedIds) {
			if (!validHexOrGlobal.test(id)) {
				throw new AgentError('E_INVALID_PARAMS', `Invalid sys_id "${id}". Must be a 32-character hexadecimal string or 'global'.`);
			}
		}

		// Selection combination with ^ (AND)
		const queryParts: string[] = [];
		if (normalizedIds.length === 1) {
			queryParts.push(`sys_id=${normalizedIds[0]}`);
		} else if (normalizedIds.length > 1) {
			queryParts.push(`sys_idIN${normalizedIds.join(',')}`);
		}
		if (typeof params?.query === 'string' && params.query.trim()) {
			queryParts.push(params.query.trim());
		}
		const combinedQuery = queryParts.join('^');

		// Resolve code fields
		let codeFields: string[] = [];
		if (Array.isArray(params?.fields)) {
			codeFields = params.fields.filter((f: any) => typeof f === 'string' && /^[a-zA-Z0-9_]+$/.test(f.trim())).map((f: string) => f.trim());
		} else if (typeof params?.field === 'string' && /^[a-zA-Z0-9_]+$/.test(params.field.trim())) {
			codeFields = [params.field.trim()];
		}
		if (codeFields.length === 0) {
			codeFields = resolveTableCodeFields(table);
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const instanceName = path.basename(ctx.instanceFolder);

		const displayFields = ['sys_id', 'name', 'sys_name', 'short_description', 'sys_scope', 'sys_scope.scope'];
		const allRequestedFields = Array.from(new Set([...displayFields, ...codeFields])).join(',');

		const queryParams: Record<string, string> = {
			sysparm_fields: allRequestedFields,
			sysparm_limit: String(limit),
			sysparm_display_value: 'false',
			sysparm_exclude_reference_link: 'true',
			sysparm_no_count: 'true',
		};
		if (combinedQuery) {
			queryParams.sysparm_query = combinedQuery;
		}

		const { data } = await restRequest(ctx, instanceSettings, {
			endpoint: `/api/now/table/${table}`,
			method: 'GET',
			queryParams,
		});

		const matchedRecords: any[] = Array.isArray(data?.result) ? data.result : (data?.result ? [data.result] : []);
		const isFolderRecordTable = Constants.FOLDERRECORDTABLES.includes(table);

		let filesWritten = 0;
		let skippedEmpty = 0;
		const warnings: string[] = [];
		const pulledRecordsList: Array<{
			sys_id: string;
			name: string;
			scope: string;
			files: Array<{ field: string; path: string; bytes: number; action: 'created' | 'updated' | 'cleared' | 'skipped_empty' }>;
		}> = [];

		for (const rec of matchedRecords) {
			const sysId = typeof rec.sys_id === 'object' ? rec.sys_id.value : String(rec.sys_id || '');
			if (!sysId) continue;

			// Scope resolution
			let scope = 'global';
			if (rec['sys_scope.scope']) {
				scope = String(rec['sys_scope.scope']);
			} else if (rec.sys_scope) {
				scope = typeof rec.sys_scope === 'object' ? String(rec.sys_scope.value || rec.sys_scope.display_value || 'global') : String(rec.sys_scope);
			}
			if (!scope || scope === 'null' || scope === 'undefined') scope = 'global';

			const rawName = rec.name || rec.sys_name || rec.short_description || sysId;
			const name = String(rawName).trim();

			// Read / update _map.json
			let mapPath: string;
			try {
				mapPath = safeJoinUnderRoot(ctx.workspaceRoot, instanceName, scope, table, '_map.json');
			} catch (e: any) {
				warnings.push(`Could not resolve map path for ${scope}/${table}: ${e?.message || e}`);
				continue;
			}

			let nameToSysId: Record<string, string> = {};
			if (fs.existsSync(mapPath)) {
				try { nameToSysId = JSON.parse(fs.readFileSync(mapPath, 'utf8')) || {}; } catch {}
			}

			let cleanName = name.replace(/[^a-z0-9._\-+]+/gi, '').replace(/\./g, '-') || sysId;
			const existingKey = Object.keys(nameToSysId).find((k) => nameToSysId[k] === sysId);
			if (existingKey) {
				cleanName = existingKey;
			} else if (nameToSysId[cleanName] && nameToSysId[cleanName] !== sysId) {
				cleanName = `${cleanName}-${sysId.slice(0, 2)}${sysId.slice(-2)}`.toUpperCase();
			}
			nameToSysId[cleanName] = sysId;

			// Write _map.json
			try {
				ExtensionUtils.markSelfWrite(mapPath);
				await fs.promises.mkdir(path.dirname(mapPath), { recursive: true });
				await fs.promises.writeFile(mapPath, JSON.stringify(nameToSysId, null, 4), 'utf8');
			} catch (e: any) {
				warnings.push(`Failed to write _map.json at ${mapPath}: ${e?.message || e}`);
			}

			// Special handling for sp_widget: _test_urls.txt
			if (table === 'sp_widget') {
				try {
					const testUrlsPath = safeJoinUnderRoot(ctx.workspaceRoot, instanceName, scope, table, cleanName, '_test_urls.txt');
					if (!fs.existsSync(testUrlsPath)) {
						const dispVal = name.toLowerCase().replace(/\s+/g, '_');
						const testUrls = [
							`${instanceSettings.url}/$sp.do?id=sp-preview&sys_id=${sysId}`,
							`${instanceSettings.url}/sp_config?id=${dispVal}`,
							`${instanceSettings.url}/sp?id=${dispVal}`,
							`${instanceSettings.url}/esc?id=${dispVal}`,
						].join('\n');
						ExtensionUtils.markSelfWrite(testUrlsPath);
						await fs.promises.mkdir(path.dirname(testUrlsPath), { recursive: true });
						await fs.promises.writeFile(testUrlsPath, testUrls, 'utf8');
					}
				} catch {}
			}

			const recordFiles: Array<{ field: string; path: string; bytes: number; action: 'created' | 'updated' | 'cleared' | 'skipped_empty' }> = [];

			for (const field of codeFields) {
				const ext = resolveFieldExtension(table, field);
				let targetPath: string;
				try {
					targetPath = isFolderRecordTable
						? safeJoinUnderRoot(ctx.workspaceRoot, instanceName, scope, table, cleanName, `${field}${ext}`)
						: safeJoinUnderRoot(ctx.workspaceRoot, instanceName, scope, table, `${cleanName}.${field}${ext}`);
				} catch (e: any) {
					warnings.push(`Unsafe path for ${scope}/${table}/${cleanName}.${field}: ${e?.message || e}`);
					continue;
				}

				const relPath = path.relative(ctx.workspaceRoot, targetPath).replace(/\\/g, '/');
				const rawVal = rec[field];
				const content = rawVal !== null && rawVal !== undefined ? String(rawVal) : '';
				const fileExisted = fs.existsSync(targetPath);

				if (content.length > 0) {
					try {
						ExtensionUtils.markSelfWrite(targetPath);
						await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
						await fs.promises.writeFile(targetPath, content, 'utf8');
						filesWritten++;
						const action = fileExisted ? 'updated' : 'created';
						recordFiles.push({ field, path: relPath, bytes: Buffer.byteLength(content, 'utf8'), action });

						if (openFiles) {
							try {
								const doc = await vscode.workspace.openTextDocument(targetPath);
								await vscode.window.showTextDocument(doc, { preview: false });
							} catch {}
						}
					} catch (e: any) {
						warnings.push(`Failed to write ${relPath}: ${e?.message || e}`);
					}
				} else if (fileExisted) {
					// Empty remote field, but local file exists -> clear stale code
					try {
						ExtensionUtils.markSelfWrite(targetPath);
						await fs.promises.writeFile(targetPath, '', 'utf8');
						filesWritten++;
						recordFiles.push({ field, path: relPath, bytes: 0, action: 'cleared' });
					} catch (e: any) {
						warnings.push(`Failed to clear ${relPath}: ${e?.message || e}`);
					}
				} else {
					// Empty remote field and no local file -> skip
					skippedEmpty++;
					recordFiles.push({ field, path: relPath, bytes: 0, action: 'skipped_empty' });
				}
			}

			pulledRecordsList.push({
				sys_id: sysId,
				name,
				scope,
				files: recordFiles,
			});
		}

		ctx.log(`Agent API: Pulled ${pulledRecordsList.length}/${matchedRecords.length} record(s) from ${table} (${filesWritten} file(s) written, ${skippedEmpty} skipped empty)`);

		return {
			table,
			matchedRecords: matchedRecords.length,
			pulledRecords: pulledRecordsList.length,
			filesWritten,
			skippedEmpty,
			warnings,
			records: pulledRecordsList,
		};
	},
};

const pull_artifacts: CommandHandler = {
	...pull_records,
	name: 'pull_artifacts',
	docs: {
		...pull_records.docs,
		summary: 'Alias for pull_records: pull artifacts from ServiceNow into canonical local workspace files.',
	},
};

export const recordsCommands: CommandHandler[] = [
	update_record,
	update_record_batch,
	create_artifact,
	create_record,
	get_record,
	delete_record,
	get_table_metadata,
	check_name_exists_remote,
	pull_records,
	pull_artifacts,
];

