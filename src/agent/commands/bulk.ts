import * as crypto from 'crypto';
import { AgentContext, CommandHandler } from '../types';
import { AgentError, AgentErrorCode } from '../errors';
import { mustGetInstanceSettings, restRequest } from './_shared';
import { resolveScopeForCreate } from './records';
import {
	BulkBatch,
	BulkMode,
	FieldKind,
	fieldKindsFromMeta,
	isBatchId,
	newBatchId,
	normalizeRowResults,
	reconcileBulkScope,
	summarizeBulk,
	validateBulkParams,
} from '../bulkWrite';

// create_records / update_records: many records on one table in one call,
// visible row by row. The helper tab runs the rows (agentRecordBatch) and
// keeps a per-row ledger, so the outcome of every row survives a lost answer
// and can be collected with get_batch_result.

/** How much longer than the batch deadline the host waits for the answer. */
const ANSWER_GRACE_MS = 30_000;

/**
 * The batch may have run, partly run or still be running once it was sent, so
 * a lost answer (timeout, helper disconnect, bridge stop) is never reported as
 * a retryable failure: it keeps the batchId and points at get_batch_result.
 */
export function lostAnswer(batchId: string, err: any): AgentError {
	const cause = err?.code || 'E_INTERNAL';
	return new AgentError('E_TIMEOUT',
		`No answer for batch ${batchId} (${cause}). The helper tab may have written some or all rows: do not send this batch again. ` +
		`Once the helper tab is connected, call get_batch_result with this batchId and retry only rows it reports as not_attempted or failed.`,
		{ batchId, cause, retrySafe: false });
}

/**
 * Refuse a table that does not exist on the instance. The Table API answers
 * 400 "Invalid table" for it; any other answer (rows, none, an ACL refusal)
 * leaves the decision to the write itself.
 */
async function assertTableExists(ctx: AgentContext, table: string): Promise<void> {
	try {
		await restRequest(ctx, mustGetInstanceSettings(ctx.instanceFolder), {
			endpoint: `/api/now/table/${table}`,
			method: 'GET',
			queryParams: { sysparm_limit: '1', sysparm_fields: 'sys_id', sysparm_no_count: 'true' },
		});
	} catch (err: any) {
		if (isMissingTable(err?.details?.status, err?.message)) {
			throw new AgentError('E_INVALID_PARAMS', `Table "${table}" does not exist on this instance.`);
		}
	}
}

/**
 * What Sync Now does with a staged batch's rows file once its replay answered.
 * keep: nothing ran (invalid, rejected, expired, lost answer), the file stays
 * with the same batch id. done: every row succeeded. retry: the rows that
 * failed or were not attempted go back as a new batch; rows with no answer are
 * left out because they may exist.
 */
export function stagedBatchDecision(resp: { status: string; code?: string; result?: any; details?: any }, editedRows: any[]):
	{ action: 'keep' | 'done' | 'retry'; retryRows: any[]; unknown: number } {
	const outcome = resp.status === 'success' ? resp.result : resp.details;
	const rows: any[] | undefined = Array.isArray(outcome?.rows) ? outcome.rows : undefined;
	if (!rows || resp.code === 'E_REVIEW_PENDING' || outcome?.running === true) return { action: 'keep', retryRows: [], unknown: 0 };
	const retryRows = rows.filter(r => r?.outcome === 'failed' || r?.outcome === 'not_attempted')
		.map(r => editedRows[r.index]).filter(Boolean);
	const unknown = rows.filter(r => r?.outcome === 'unknown').length;
	return { action: retryRows.length ? 'retry' : 'done', retryRows, unknown };
}

/**
 * Compare rules for the written fields, from the table's column metadata.
 * Best effort: without metadata the helper compares every field as text.
 */
async function readFieldKinds(ctx: AgentContext, table: string, fieldNames: string[]): Promise<Record<string, FieldKind> | undefined> {
	try {
		const { data } = await restRequest(ctx, mustGetInstanceSettings(ctx.instanceFolder), { endpoint: `/api/now/ui/meta/${table}`, method: 'GET' });
		const kinds = fieldKindsFromMeta(data?.result?.columns, fieldNames);
		return Object.keys(kinds).length ? kinds : undefined;
	} catch {
		return undefined;
	}
}

export function isMissingTable(status: unknown, message: unknown): boolean {
	return status === 400 && /invalid table/i.test(String(message || ''));
}

function invalid(err: any): never {
	if (err?.code === 'E_INVALID_PARAMS') throw new AgentError('E_INVALID_PARAMS', err.message);
	throw err;
}

function requireRecordBatchHelper(ctx: AgentContext): void {
	if (ctx.getHelperBuildInfo()?.capabilities?.recordBatch !== 1) {
		throw new AgentError('E_UNSUPPORTED_HOST',
			'The connected SN Utils helper tab cannot run multi-record writes. Update SN Utils (10.2.8.0 or later) and reopen the ScriptSync helper tab.');
	}
}

/** The rows as the caller wrote them, for the staged review file. */
function flatRows(batch: BulkBatch): Record<string, any>[] {
	return batch.rows.map(r => (r.sys_id ? { sys_id: r.sys_id, ...r.fields } : { ...r.fields }));
}

async function prepareBatch(ctx: AgentContext, mode: BulkMode, params: any): Promise<any> {
	let plan;
	try { plan = validateBulkParams(mode, params); } catch (err) { invalid(err); }
	await assertTableExists(ctx, plan.table);
	const fieldKinds = await readFieldKinds(ctx, plan.table, Array.from(new Set(plan.rows.flatMap(r => Object.keys(r.fields)))));

	let scope: { transactionScope?: string; effectiveScope?: string } = {};
	if (mode === 'create') {
		const wantsScope = params?.scope !== undefined || plan.pinnedScopes.length > 0;
		const resolution = params?.scope !== undefined
			? await resolveScopeForCreate(ctx, mustGetInstanceSettings(ctx.instanceFolder), params.scope, {})
			: undefined;
		if (wantsScope) {
			try { scope = reconcileBulkScope(resolution, plan.pinnedScopes); } catch (err) { invalid(err); }
		}
	}

	// A replay of a staged batch keeps its id; a caller-supplied __batch never
	// reaches here (the dispatcher strips it).
	const previous = params?.__batch?.batchId;
	const batchId = isBatchId(previous) ? previous : newBatchId(crypto.randomBytes(4).toString('hex'));
	const { __batch, ...rest } = params || {};
	const batch: BulkBatch & { effectiveScope?: string } = {
		batchId,
		mode,
		table: plan.table,
		rows: plan.rows,
		...(scope.transactionScope ? { transactionScope: scope.transactionScope } : {}),
		...(scope.effectiveScope ? { effectiveScope: scope.effectiveScope } : {}),
		continueOnError: plan.continueOnError,
		deadlineMs: plan.deadlineMs,
		...(fieldKinds ? { fieldKinds } : {}),
	};
	return { ...rest, __batch: batch };
}

/**
 * Turn the helper's ledger report into the command result, or throw the
 * overall error with every row's outcome in details.
 */
export function batchResult(reply: any, expected: { batchId?: string; total?: number; table?: string; mode?: string; effectiveScope?: string }) {
	if (!reply || reply.success === false) {
		const code = (reply?.code || 'E_COMMAND_FAILED') as AgentErrorCode;
		throw new AgentError(code, reply?.error || 'Record batch failed', { batchId: expected.batchId });
	}
	const report = reply.batch || {};
	const total = Number.isInteger(report.total) ? report.total : (expected.total ?? 0);
	const rows = normalizeRowResults(total, report.rows);
	const base = {
		batchId: report.batchId || expected.batchId,
		table: report.table || expected.table,
		mode: report.mode || expected.mode,
		...(expected.effectiveScope ? { effectiveScope: expected.effectiveScope } : {}),
		...(reply.duplicate ? { duplicate: true } : {}),
		...(report.interrupted ? { interrupted: true } : {}),
		...(report.stopReason ? { stopReason: report.stopReason } : {}),
	};
	if (report.running) {
		const done = rows.filter(r => r.outcome === 'succeeded' || r.outcome === 'failed').length;
		return { ...base, running: true, message: `Still running: ${done} of ${total} rows answered. Call get_batch_result again.`, rows };
	}
	const notRunCode = report.stopReason === 'deadline' ? 'E_TIMEOUT' : report.stopReason === 'session' ? 'E_TOKEN_EXPIRED' : 'E_COMMAND_FAILED';
	const summary = summarizeBulk(rows, notRunCode);
	const result = { ...base, running: false, counts: summary.counts, rows };
	if (summary.status === 'success') return { ...result, message: summary.message };
	throw new AgentError(summary.code as AgentErrorCode, summary.message, result);
}

function bulkCommand(mode: BulkMode): CommandHandler {
	const name = mode === 'create' ? 'create_records' : 'update_records';
	return {
		name,
		requiresBrowser: true,
		docs: {
			summary: mode === 'create'
				? 'Insert up to 200 records on one table in one call, with one review for the batch and an outcome per row. Rows that succeed are not rolled back.'
				: 'Update up to 200 existing records on one table in one call, with one review for the batch and an outcome per row. Rows that succeed are not rolled back.',
			request: mode === 'create'
				? { command: name, id: 'crecs_1', params: { table: 'sys_choice', scope: 'x_acme_app', rows: [{ name: 'incident', element: 'category', label: 'Network', value: 'network' }] } }
				: { command: name, id: 'urecs_1', params: { table: 'incident', rows: [{ sys_id: '0123456789abcdef0123456789abcdef', urgency: '2' }], continueOnError: true } },
		},
		prepare: (ctx, params) => {
			// Refuse an older helper before the probes and any review card. A dry
			// run, or a batch staged in Pending Saves, does not reach the helper yet.
			const staged = ctx.reviewWritesEnabled() && params?.__review_bypass !== true;
			if (params?.dryRun !== true && !staged) requireRecordBatchHelper(ctx);
			return prepareBatch(ctx, mode, params);
		},
		fromHelperResult: (reply, params) => {
			const b = params?.__batch;
			return batchResult(reply, { batchId: b?.batchId, total: b?.rows?.length, table: b?.table, mode, effectiveScope: b?.effectiveScope });
		},
		async handle(ctx, params) {
			const prepared = params?.__batch ? params : await prepareBatch(ctx, mode, params);
			const batch = prepared.__batch as BulkBatch & { effectiveScope?: string };
			const expected = { batchId: batch.batchId, total: batch.rows.length, table: batch.table, mode, effectiveScope: batch.effectiveScope };

			if (prepared.dryRun === true) {
				return {
					dryRun: true,
					message: `Valid: ${batch.rows.length} row${batch.rows.length === 1 ? '' : 's'} would be ${mode === 'create' ? 'created' : 'updated'} on ${batch.table}. Nothing was written, and business rules and ACLs are not checked by a dry run.`,
					table: batch.table,
					mode,
					...(batch.effectiveScope ? { effectiveScope: batch.effectiveScope } : {}),
					...(batch.transactionScope ? { transactionScope: batch.transactionScope } : {}),
					rows: flatRows(batch),
				};
			}

			if (ctx.reviewWritesEnabled() && prepared.__review_bypass !== true) {
				const staged = ctx.stageWrite({
					label: `${mode} ${batch.rows.length} ${batch.table} record${batch.rows.length === 1 ? '' : 's'}`,
					description: `${batch.table} · ${batch.rows.length} row${batch.rows.length === 1 ? '' : 's'}`,
					preview: JSON.stringify(flatRows(batch), null, 2),
					previewLanguage: 'json',
					fileName: `${batch.table}.rows.json`,
				});
				return { ...staged, batchId: batch.batchId };
			}

			requireRecordBatchHelper(ctx);
			const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
			const correlationId = `agent_${ctx.request.id}_${Date.now()}_batch`;
			const pending = ctx.waitForBrowserResponse<any>(correlationId, batch.deadlineMs + ANSWER_GRACE_MS);
			const { effectiveScope, ...wire } = batch;
			// A send that throws reached nothing, so that failure is safe to retry.
			ctx.sendToBrowser({ action: 'agentRecordBatch', agentRequestId: correlationId, ...wire, instance: instanceSettings, appName: 'VS Code' });
			let reply: any;
			try {
				reply = await pending;
			} catch (err: any) {
				throw lostAnswer(batch.batchId, err);
			}
			ctx.log(`Agent API: record batch ${batch.batchId} answered (${batch.table}, ${batch.rows.length} rows)`);
			return batchResult(reply, expected);
		},
	};
}

const get_batch_result: CommandHandler = {
	name: 'get_batch_result',
	requiresBrowser: true,
	docs: {
		summary: 'Collect the outcome of a create_records / update_records batch by its batchId, also after the original call timed out or the connection dropped. Kept for 24 hours in the browser that ran it.',
		request: { command: 'get_batch_result', id: 'batch_1', params: { batchId: 'bat_lzx1y2_a1b2c3d4' } },
	},
	async handle(ctx, params) {
		const batchId = params?.batchId;
		if (!isBatchId(batchId)) throw new AgentError('E_INVALID_PARAMS', 'Missing or invalid param "batchId" (as returned by create_records / update_records)');
		requireRecordBatchHelper(ctx);
		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const correlationId = `agent_${ctx.request.id}_${Date.now()}_batchresult`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId);
		ctx.sendToBrowser({ action: 'agentBatchResult', agentRequestId: correlationId, batchId, instance: instanceSettings, appName: 'VS Code' });
		return batchResult(await pending, { batchId });
	},
};

export const bulkCommands: CommandHandler[] = [bulkCommand('create'), bulkCommand('update'), get_batch_result];
