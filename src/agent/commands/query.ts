import * as path from 'path';
import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { ExtensionUtils } from '../../ExtensionUtils';

const eu = new ExtensionUtils();

function mustGetInstanceSettings(instanceFolder: string) {
	const s = eu.getInstanceSettings(path.basename(instanceFolder));
	if (!s || !s.url) {
		throw new AgentError('E_INSTANCE_NOT_FOUND', 'Instance settings not found. Ensure _settings.json exists.');
	}
	return s;
}

const query_records: CommandHandler = {
	name: 'query_records',
	requiresBrowser: true,
	docs: {
		summary: 'Run an arbitrary encoded query against any table and return matching records.',
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
