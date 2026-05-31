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
		summary: 'Add a column to a table by creating a sys_dictionary entry (keyed by table.element). Avoids the _map.json name collision of create_artifact.',
		request: {
			command: 'add_column',
			id: 'col_1',
			params: { table: 'x_acme_myapp_widget', element: 'priority', type: 'integer', label: 'Priority', scope: 'x_acme_myapp' },
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
		ctx.log(`Agent API: Added column ${table}.${element} (${type}) sys_id=${sysId}`);
		return { created: true, table, element, type, label, sys_id: sysId };
	},
};

export const scopedAppCommands: CommandHandler[] = [create_application, add_column];
