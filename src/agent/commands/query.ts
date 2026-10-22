import * as path from 'path';
import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { ExtensionUtils } from '../../ExtensionUtils';
import { Columns, columnsFromMeta, createSchemaCache, parentFromDbObject, queryValidationError, validateQuery } from '../queryValidation';
import { restRequest } from './_shared';

const eu = new ExtensionUtils();

function mustGetInstanceSettings(instanceFolder: string) {
	const s = eu.getInstanceSettings(path.basename(instanceFolder));
	if (!s || !s.url) {
		throw new AgentError('E_INSTANCE_NOT_FOUND', 'Instance settings not found. Ensure _settings.json exists.');
	}
	return s;
}

// One column cache and one table-parent cache per instance URL; entries
// outlive the request that read them.
const schemaCaches = new Map<string, { columns: ReturnType<typeof createSchemaCache<Columns | null>>; parents: ReturnType<typeof createSchemaCache<string | null>> }>();

function schemaLookups(ctx: any, instanceSettings: any) {
	let caches = schemaCaches.get(instanceSettings.url);
	if (!caches) {
		caches = { columns: createSchemaCache<Columns | null>(), parents: createSchemaCache<string | null>(undefined, undefined, (parent) => typeof parent === 'string') };
		schemaCaches.set(instanceSettings.url, caches);
	}
	const fetchColumns = async (table: string) => {
		const { data } = await restRequest(ctx, instanceSettings, { endpoint: `/api/now/ui/meta/${table}`, method: 'GET' });
		return columnsFromMeta(data);
	};
	const fetchParent = async (table: string) => {
		const { data } = await restRequest(ctx, instanceSettings, {
			endpoint: '/api/now/table/sys_db_object', method: 'GET',
			queryParams: { sysparm_query: `name=${table}`, sysparm_fields: 'super_class.name', sysparm_limit: '1' },
		});
		return parentFromDbObject(data);
	};
	const { columns, parents } = caches;
	return {
		columns: (table: string) => columns(table, fetchColumns),
		parentOf: (table: string) => parents(table, fetchParent),
	};
}

const query_records: CommandHandler = {
	name: 'query_records',
	requiresBrowser: true,
	docs: {
		summary: 'Run an arbitrary encoded query against any table and return matching records. Every field path in query, fields and orderBy is checked against the table schema first (values are not judged): a path that does not exist fails with E_INVALID_QUERY, one that cannot be checked with E_QUERY_UNVERIFIABLE, and the query is not run. ServiceNow would otherwise ignore the condition and return unfiltered rows. Pass validate:false to skip the check.',
		request: {
			command: 'query_records',
			id: 'q_1',
			params: { table: 'sys_script_include', query: 'active=true', fields: 'sys_id,name', limit: 10 },
		},
	},
	async handle(ctx, params) {
		const table = params?.table;
		const encodedQuery: string = params?.query || '';
		const fields: string = params?.fields || 'sys_id,number,short_description,sys_created_on';
		const limit: number = params?.limit || 10;
		const orderBy: string = params?.orderBy || '';

		if (!table) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: table');

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		// Only caller-supplied fields are checked: the default list is a
		// convenience for task tables, not something the caller asked for.
		if (params?.validate !== false) {
			const lookups = schemaLookups(ctx, instanceSettings);
			const invalid = queryValidationError(await validateQuery(table, { query: encodedQuery, fields: params?.fields, orderBy }, lookups.columns, lookups.parentOf));
			if (invalid) throw new AgentError(invalid.code, invalid.message, invalid.details);
		}

		let queryString = `sysparm_fields=${fields}&sysparm_limit=${limit}`;
		if (encodedQuery) queryString += `&sysparm_query=${encodedQuery}`;
		if (orderBy) {
			if (encodedQuery) {
				queryString = queryString.replace(`sysparm_query=${encodedQuery}`, `sysparm_query=${encodedQuery}^${orderBy}`);
			} else {
				queryString += `&sysparm_query=${orderBy}`;
			}
		}

		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'agentQueryRecords',
			agentRequestId: correlationId,
			tableName: table,
			queryString,
			instance: instanceSettings,
		});
		ctx.log(`Agent API: Sent query request to ${table}: ${encodedQuery}`);

		const response = await pending;
		if (!response || response.success === false) {
			const msg = response?.error || 'Failed to query records';
			const isAuth = msg.toLowerCase().includes('not authenticated') || msg.toLowerCase().includes('not authorized') || msg.toLowerCase().includes('401');
			const code = response?.code || (isAuth ? 'E_UNAUTHORIZED' : 'E_REST_ERROR');
			const hint = isAuth ? ' Session is not authenticated. Open the instance in your browser, log in, and run /token.' : '';
			throw new AgentError(code, `${msg}.${hint}`, response?.details);
		}

		return {
			table: response?.tableName ?? table,
			count: response?.count ?? (response?.records?.length || 0),
			records: response?.records ?? [],
		};
	},
};

const get_parent_options: CommandHandler = {
	name: 'get_parent_options',
	requiresBrowser: true,
	docs: {
		summary: 'Fetch reference options from a table (e.g. parent services for sys_ws_operation).',
		request: {
			command: 'get_parent_options',
			id: 'po_1',
			params: { table: 'sys_ws_service', scope: '<scope_sys_id>', nameField: 'name', limit: 50 },
		},
	},
	async handle(ctx, params) {
		const table = params?.table;
		const scope: string | undefined = params?.scope;
		const nameField: string = params?.nameField || 'name';
		const limit: number = params?.limit || 50;

		if (!table) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: table');
		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);

		let queryString = `sysparm_fields=sys_id,${nameField},sys_scope&sysparm_limit=${limit}`;
		queryString += scope
			? `&sysparm_query=sys_scope.scope=${scope}^ORDERBYname`
			: `&sysparm_query=ORDERBYname`;

		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'agentGetParentOptions',
			agentRequestId: correlationId,
			tableName: table,
			nameField,
			queryString,
			instance: instanceSettings,
		});
		ctx.log(`Agent API: Sent request for parent options from ${table}`);

		const response = await pending;
		const records = response?.result || [];
		const actualNameField = response?.nameField || nameField;
		return {
			table: response?.tableName ?? table,
			count: records.length,
			options: records.map((r: any) => ({
				sys_id: r.sys_id,
				name: r[actualNameField] || r.name || r.sys_id,
				scope: r.sys_scope?.value || r.sys_scope || 'global',
			})),
		};
	},
};

export const queryCommands: CommandHandler[] = [query_records, get_parent_options];
