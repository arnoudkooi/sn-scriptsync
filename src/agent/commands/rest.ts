import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { mustGetInstanceSettings, getSetting, restRequest } from './_shared';

const VALID_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = typeof VALID_METHODS[number];

const rest_request: CommandHandler = {
	name: 'rest_request',
	requiresBrowser: true,
	docs: {
		summary: 'Generic ServiceNow REST passthrough via the browser session. GET is always allowed; write methods are gated by settings.',
		request: {
			command: 'rest_request',
			id: 'rest_1',
			params: { endpoint: '/api/now/table/incident', method: 'GET', queryParams: { sysparm_limit: '1' } },
		},
	},
	async handle(ctx, params) {
		const endpoint = params?.endpoint;
		if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
			throw new AgentError('E_INVALID_PARAMS', "Missing/invalid 'endpoint' (must be an instance-relative path beginning with '/', e.g. /api/now/table/incident)");
		}
		const method = String(params?.method || 'GET').toUpperCase() as Method;
		if (!VALID_METHODS.includes(method)) {
			throw new AgentError('E_INVALID_PARAMS', `Invalid method. Must be one of: ${VALID_METHODS.join(', ')}`);
		}

		// Gating: reads are free; writes require the generic-write toggle; deletes
		// additionally require the dedicated delete toggle.
		if (method === 'DELETE' && !getSetting('deleteRecords.enabled', false)) {
			throw new AgentError('E_DISABLED', 'DELETE via rest_request is disabled. Enable sn-scriptsync.deleteRecords.enabled to allow it.');
		}
		if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && !getSetting('restRequest.enabled', false)) {
			throw new AgentError('E_DISABLED', `${method} via rest_request is disabled. Enable sn-scriptsync.restRequest.enabled to allow write passthrough.`);
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const { status, data } = await restRequest(ctx, instanceSettings, {
			endpoint,
			method,
			body: params?.body,
			queryParams: params?.queryParams && typeof params.queryParams === 'object' ? params.queryParams : undefined,
		});
		return { status, data };
	},
};

export const restCommands: CommandHandler[] = [rest_request];
