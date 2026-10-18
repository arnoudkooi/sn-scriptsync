import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, CommandHandler } from '../types';
import { AgentError } from '../errors';
import { mustGetInstanceSettings, restRequest } from './_shared';
import {
	ProfileIO,
	analyzeArtifactType,
	currentFingerprint,
	profileFileName,
	profileStillFresh,
	validateProfileParams,
} from '../artifactProfile';

// analyze_artifact_type: read-only. Every request below is a GET through the
// helper tab (Table API and Aggregate API), as the connected user.

function readOnlyIO(ctx: AgentContext): ProfileIO {
	const instance = mustGetInstanceSettings(ctx.instanceFolder);
	return {
		async query(table, query, fields, limit) {
			const { data } = await restRequest(ctx, instance, {
				endpoint: `/api/now/table/${table}`,
				method: 'GET',
				queryParams: {
					sysparm_query: query,
					sysparm_fields: fields.join(','),
					sysparm_limit: String(limit),
					sysparm_exclude_reference_link: 'true',
					sysparm_display_value: 'false',
					sysparm_no_count: 'true',
				},
			});
			return Array.isArray(data?.result) ? data.result : [];
		},
		async count(table, query) {
			const { data } = await restRequest(ctx, instance, {
				endpoint: `/api/now/stats/${table}`,
				method: 'GET',
				queryParams: { sysparm_count: 'true', sysparm_query: query },
			});
			const n = Number(data?.result?.stats?.count);
			if (!Number.isFinite(n)) throw new AgentError('E_COMMAND_FAILED', `No count returned for ${table}`);
			return n;
		},
	};
}

const analyze_artifact_type: CommandHandler = {
	name: 'analyze_artifact_type',
	requiresBrowser: true,
	docs: {
		summary: 'Read-only: sample existing artifacts of a type (table, catalog_item) and compare them into a type profile (observed recurrence, recorded platform generation and requirements, creation paths, provenance, coverage). Use before building an unfamiliar composite artifact; the profile is saved and reused while fresh.',
		request: { command: 'analyze_artifact_type', id: 'prof_1', params: { type: 'table', scope: 'x_acme_app' } },
	},
	async handle(ctx, params) {
		let p;
		try { p = validateProfileParams({ ...params, instance: path.basename(ctx.instanceFolder) }); }
		catch (err: any) { throw new AgentError('E_INVALID_PARAMS', err.message); }
		const io = readOnlyIO(ctx);
		const dir = path.join(ctx.instanceFolder, '_profiles');
		const file = path.join(dir, profileFileName(p));

		if (params?.refresh !== true && fs.existsSync(file)) {
			try {
				const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
				const check = profileStillFresh(saved, p, await currentFingerprint(io, saved));
				if (check.fresh) return { ...saved, reused: true, reuseReason: check.reason, savedTo: file };
				ctx.log(`Agent API: profile ${path.basename(file)} not reused: ${check.reason}`);
			} catch { /* unreadable or stale file: analyze again */ }
		}

		const profile = await analyzeArtifactType(io, p);
		if (params?.save !== false) {
			try {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(file, JSON.stringify(profile, null, 2));
			} catch (err: any) {
				profile.warnings.push(`Profile not saved: ${err?.message || err}`);
			}
		}
		ctx.log(`Agent API: profiled ${profile.samples.analyzed} ${p.type} sample(s)`);
		return { ...profile, reused: false, ...(params?.save !== false ? { savedTo: file } : {}) };
	},
};

export const profileCommands: CommandHandler[] = [analyze_artifact_type];
