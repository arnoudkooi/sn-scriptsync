import * as fs from 'fs';
import * as path from 'path';
import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { mustGetInstanceSettings, getSetting, restRequest } from './_shared';

function isCreateArtifactsEnabled(): boolean {
	return getSetting('createArtifacts.enabled', true);
}

function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/** Persist a scope name -> sys_id mapping so create_artifact/add_column can resolve it. */
function rememberScope(instanceFolder: string, scopeName: string, scopeSysId: string, log: (m: string) => void) {
	if (!scopeName || !scopeSysId) return;
	const scopesPath = path.join(instanceFolder, 'scopes.json');
	try {
		let scopes: Record<string, string> = {};
		if (fs.existsSync(scopesPath)) scopes = JSON.parse(fs.readFileSync(scopesPath, 'utf8')) || {};
		scopes[scopeName] = scopeSysId;
		fs.writeFileSync(scopesPath, JSON.stringify(scopes, null, 2));
		log(`Agent API: Recorded scope ${scopeName} -> ${scopeSysId} in scopes.json`);
	} catch { /* best-effort */ }
}

function resolveScopeSysId(instanceFolder: string, scopeName?: string): string | undefined {
	if (!scopeName || scopeName === 'global') return undefined;
	const scopesPath = path.join(instanceFolder, 'scopes.json');
	if (fs.existsSync(scopesPath)) {
		try {
			const scopes = JSON.parse(fs.readFileSync(scopesPath, 'utf8'));
			if (scopes[scopeName]) return scopes[scopeName];
		} catch { /* ignore */ }
	}
	return undefined;
}

/** Coerce a truthy/falsy param into the 'true'/'false' strings the Table API expects. */
function boolStr(v: any): string {
	return (v === true || v === 'true' || v === 1 || v === '1') ? 'true' : 'false';
}

const create_application: CommandHandler = {
	name: 'create_application',
	requiresBrowser: true,
	docs: {
		summary: 'Create a scoped application (sys_app). Scope is set at insert time (it is read-only afterwards). Returns the scope name + sys_id.',
		request: {
			command: 'create_application',
			id: 'app_1',
			params: { name: 'My Cool App', prefix: 'acme', short_description: 'Demo app' },
		},
	},
	async handle(ctx, params) {
		if (!isCreateArtifactsEnabled()) {
			throw new AgentError('E_DISABLED', 'Artifact creation is disabled by setting sn-scriptsync.createArtifacts.enabled');
		}
		const name = params?.name;
		if (!name) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: name');

		// Determine the scope name. Prefer an explicit scope; otherwise derive
		// x_<prefix>_<slug> from a provided vendor prefix.
		let scope: string | undefined = params?.scope;
		if (!scope) {
			const prefix = params?.prefix;
			if (!prefix) {
				throw new AgentError('E_INVALID_PARAMS', "Provide either an explicit 'scope' (e.g. x_acme_myapp) or a 'prefix' (vendor code) so the scope can be derived as x_<prefix>_<slug>.");
			}
			scope = `x_${slugify(prefix)}_${slugify(name)}`;
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const payload: Record<string, any> = {
			name,
			scope,
			short_description: params?.short_description || params?.description || name,
			version: params?.version || '1.0.0',
			active: 'true',
		};

		const { data } = await restRequest(ctx, instanceSettings, {
			endpoint: '/api/now/table/sys_app',
			method: 'POST',
			body: payload,
		});
		const rec = data?.result;
		const sysId = rec?.sys_id && typeof rec.sys_id === 'object' ? rec.sys_id.value : rec?.sys_id;
		const persistedScope = (rec?.scope && typeof rec.scope === 'object' ? rec.scope.value : rec?.scope) || scope;

		if (sysId) rememberScope(ctx.instanceFolder, persistedScope, sysId, ctx.log);
		ctx.log(`Agent API: Created application '${name}' scope=${persistedScope} sys_id=${sysId}`);
		return { created: true, name, scope: persistedScope, sys_id: sysId };
	},
};

const add_column: CommandHandler = {
	name: 'add_column',
	requiresBrowser: true,
	docs: {
		summary: 'Add a column to a table by creating a sys_dictionary entry (keyed by table.element). Avoids the _map.json name collision of create_artifact. Optional attributes (display, mandatory, default, read_only, reference_qual, choice mode, choices[]) make the column usable in one call.',
		request: {
			command: 'add_column',
			id: 'col_1',
			params: { table: 'x_acme_myapp_widget', element: 'priority', type: 'integer', label: 'Priority', display: true, mandatory: true, scope: 'x_acme_myapp' },
		},
	},
	async handle(ctx, params) {
		if (!isCreateArtifactsEnabled()) {
			throw new AgentError('E_DISABLED', 'Artifact creation is disabled by setting sn-scriptsync.createArtifacts.enabled');
		}
		const table = params?.table;
		const element = params?.element || params?.column;
		if (!table || !element) throw new AgentError('E_INVALID_PARAMS', 'Missing required params: table, element');

		const type = params?.type || 'string';
		const label = params?.label || element.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const payload: Record<string, any> = {
			name: table,
			element,
			internal_type: type,
			column_label: label,
		};
		if (params?.max_length) payload.max_length = String(params.max_length);
		if (params?.reference) payload.reference = params.reference;
		// Optional column attributes so the column is usable in one call.
		if (params?.display !== undefined) payload.display = boolStr(params.display);
		if (params?.mandatory !== undefined) payload.mandatory = boolStr(params.mandatory);
		if (params?.read_only !== undefined) payload.read_only = boolStr(params.read_only);
		if (params?.default !== undefined) payload.default_value = String(params.default);
		if (params?.reference_qual !== undefined) payload.reference_qual = String(params.reference_qual);
		// `choice` is the dropdown mode: 0 none, 1 dropdown with --None--, 3 dropdown without --None--.
		if (params?.choice !== undefined) payload.choice = String(params.choice);
		// Supplying a choices[] list implies a dropdown unless the caller set one explicitly.
		const choices = Array.isArray(params?.choices) ? params.choices : null;
		if (choices && params?.choice === undefined) payload.choice = '1';

		const queryParams: Record<string, string> = {};
		const scopeSysId = resolveScopeSysId(ctx.instanceFolder, params?.scope);
		if (scopeSysId) queryParams.sysparm_transaction_scope = scopeSysId;

		const { data } = await restRequest(ctx, instanceSettings, {
			endpoint: '/api/now/table/sys_dictionary',
			method: 'POST',
			body: payload,
			queryParams: Object.keys(queryParams).length ? queryParams : undefined,
		});
		const rec = data?.result;
		const sysId = rec?.sys_id && typeof rec.sys_id === 'object' ? rec.sys_id.value : rec?.sys_id;

		// Create sys_choice rows for a supplied choices[] list. Each entry may be a
		// plain string (used for both label and value) or { label, value, sequence }.
		const createdChoices: string[] = [];
		if (choices && choices.length) {
			for (let i = 0; i < choices.length; i++) {
				const c = choices[i];
				const cLabel = typeof c === 'string' ? c : (c?.label ?? c?.value);
				const cValue = typeof c === 'string' ? c : (c?.value ?? c?.label);
				if (cLabel === undefined || cValue === undefined) continue;
				const choiceBody: Record<string, any> = {
					name: table,
					element,
					label: String(cLabel),
					value: String(cValue),
					sequence: String((typeof c === 'object' && c?.sequence !== undefined) ? c.sequence : i),
					inactive: 'false',
				};
				try {
					await restRequest(ctx, instanceSettings, {
						endpoint: '/api/now/table/sys_choice',
						method: 'POST',
						body: choiceBody,
						queryParams: Object.keys(queryParams).length ? queryParams : undefined,
					});
					createdChoices.push(String(cValue));
				} catch (e: any) {
					ctx.log(`Agent API: Failed to add choice ${cValue} for ${table}.${element}: ${e?.message || e}`);
				}
			}
		}

		ctx.log(`Agent API: Added column ${table}.${element} (${type}) sys_id=${sysId}${createdChoices.length ? ` choices=${createdChoices.length}` : ''}`);
		const result: Record<string, any> = { created: true, table, element, type, label, sys_id: sysId };
		if (choices) result.choices = createdChoices;
		return result;
	},
};

const create_table: CommandHandler = {
	name: 'create_table',
	requiresBrowser: true,
	docs: {
		summary: 'Create a custom table (sys_db_object). ServiceNow auto-creates the physical table + base sys_ fields. Pass a scope so the name is prefixed (x_<scope>_<name>) and the table lands in the right app. Follow up with add_column for extra fields and set the display column.',
		request: {
			command: 'create_table',
			id: 'tbl_1',
			params: { name: 'project', label: 'Project', scope: 'x_acme_myapp', extends: 'task' },
		},
	},
	async handle(ctx, params) {
		if (!isCreateArtifactsEnabled()) {
			throw new AgentError('E_DISABLED', 'Artifact creation is disabled by setting sn-scriptsync.createArtifacts.enabled');
		}
		const rawName = params?.name;
		if (!rawName) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: name');

		const scope = params?.scope;
		const label = params?.label || String(rawName).replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
		const superClass = params?.extends || params?.super_class;

		// Derive the physical/internal name. Already-prefixed names are left alone;
		// otherwise a scoped table is prefixed x_<scopePrefix>_<slug>.
		let tableName = slugify(rawName);
		if (scope && scope !== 'global' && !/^x_/.test(rawName)) {
			// scope is e.g. x_acme_myapp -> reuse it as the prefix base.
			tableName = `${scope.replace(/_+$/, '')}_${slugify(rawName)}`;
		} else if (/^x_/.test(rawName)) {
			tableName = rawName;
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const payload: Record<string, any> = {
			name: tableName,
			label,
		};
		if (superClass) payload.super_class = superClass;

		const queryParams: Record<string, string> = {};
		const scopeSysId = resolveScopeSysId(ctx.instanceFolder, scope);
		if (scopeSysId) queryParams.sysparm_transaction_scope = scopeSysId;

		const { data } = await restRequest(ctx, instanceSettings, {
			endpoint: '/api/now/table/sys_db_object',
			method: 'POST',
			body: payload,
			queryParams: Object.keys(queryParams).length ? queryParams : undefined,
		});
		const rec = data?.result;
		const sysId = rec?.sys_id && typeof rec.sys_id === 'object' ? rec.sys_id.value : rec?.sys_id;
		const persistedName = (rec?.name && typeof rec.name === 'object' ? rec.name.value : rec?.name) || tableName;
		ctx.log(`Agent API: Created table '${persistedName}' label='${label}' sys_id=${sysId}`);
		return { created: true, name: persistedName, label, sys_id: sysId, scope: scope || 'global' };
	},
};

export const scopedAppCommands: CommandHandler[] = [create_application, add_column, create_table];
