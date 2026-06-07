import * as path from 'path';
import { CommandHandler } from '../types';
import { AgentError, inferCodeFromMessage } from '../errors';
import { ExtensionUtils } from '../../ExtensionUtils';

const eu = new ExtensionUtils();

function mustGetInstanceSettings(instanceFolder: string) {
	const s = eu.getInstanceSettings(path.basename(instanceFolder));
	if (!s || !s.url) {
		throw new AgentError('E_INSTANCE_NOT_FOUND', 'Instance settings not found. Ensure _settings.json exists.');
	}
	return s;
}

const code_search: CommandHandler = {
	name: 'code_search',
	requiresBrowser: true,
	docs: {
		summary: 'Run the SN Utils GraphQL field-index code search across ServiceNow script tables and return structured matches. Pro feature.',
		description:
			'Searches script/field content across the curated set of ServiceNow tables (script includes, business rules, UI actions, client scripts, etc.) ' +
			'using the same field-index GraphQL engine as the SN Utils code search page. Excellent for finding existing code an instance ' +
			'already contains before writing new artifacts. Requires an active SN Utils Pro/Trial/Enterprise license in the connected browser.',
		request: {
			command: 'code_search',
			id: 'cs_1',
			instance: 'dev12345',
			params: { term: 'sn_appclient dev mode', activeOnly: false, limit: 50 },
		},
		response: {
			status: 'success',
			result: {
				term: 'sn_appclient dev mode',
				stats: { tables: 3, records: 7, matches: 12, searchedTables: ['sys_script_include'] },
				words: ['sn_appclient', 'dev', 'mode'],
				results: [
					{
						tableName: 'sys_script_include',
						tableLabel: 'Script Include',
						rowCount: 2,
						hits: [
							{
								sysId: 'abc123...',
								name: 'AppClientUtils',
								sysClassName: 'sys_script_include',
								active: true,
								matches: [
									{
										field: 'script',
										fieldLabel: 'Script',
										matchingWords: ['dev', 'mode'],
										context: '...dev mode...',
										lineMatches: [{ lineNumber: 42, content: "var devMode = gs.getProperty('sn_appclient.dev_mode');", isMatch: true }],
									},
								],
								missingWords: null,
								parentRef: null,
							},
						],
					},
				],
			},
		},
		notes:
			'Top-level result carries stats (tables/records/matches/searchedTables) and words (the tokenized terms). Each hit has ' +
			'sysClassName, active, missingWords and parentRef; each match has matchingWords, a context excerpt, and lineMatches ' +
			'({ lineNumber, content, isMatch }) for line-level rendering. Matches are excerpts, not full field bodies — use ' +
			'get_record / query_records to pull the complete script of a specific hit. The first search after the helper tab opens ' +
			'may take longer while the field index builds; subsequent searches reuse the cached index.',
	},
	async handle(ctx, params) {
		const term: string = (params?.term ?? params?.query ?? '').toString().trim();
		if (!term || term.length < 2) {
			throw new AgentError('E_INVALID_PARAMS', 'Missing/short required param: term (min 2 characters)');
		}

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);

		const options: any = {
			activeOnly: params?.activeOnly === true,
			limit: Number.isInteger(params?.limit) && params.limit > 0 ? params.limit : 50,
		};
		if (typeof params?.tables === 'string' && params.tables.trim()) {
			options.tables = params.tables.trim();
		}

		const correlationId = `agent_${ctx.request.id}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);

		ctx.sendToBrowser({
			action: 'agentCodeSearch',
			agentRequestId: correlationId,
			searchTerm: term,
			options,
			instance: instanceSettings,
		});
		ctx.log(`Agent API: Sent code search request: "${term}"`);

		const response = await pending;

		if (response?.success === false) {
			if (response?.code === 'E_PRO_REQUIRED') {
				throw new AgentError('E_DISABLED', response?.error || 'GraphQL code search requires SN Utils Pro.');
			}
			throw new AgentError(inferCodeFromMessage(response?.error), response?.error || 'Code search failed.');
		}

		return {
			term: response?.searchTerm ?? term,
			stats: response?.stats ?? {},
			words: response?.words ?? [],
			results: response?.results ?? [],
		};
	},
};

export const searchCommands: CommandHandler[] = [code_search];
