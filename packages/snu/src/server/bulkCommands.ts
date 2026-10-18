import * as crypto from 'crypto';
import {
  BulkBatch,
  BulkMode,
  fieldKindsFromMeta,
  isBatchId,
  newBatchId,
  normalizeRowResults,
  reconcileBulkScope,
  summarizeBulk,
  validateBulkParams,
} from './bulkWrite.js';
import { ScopeResolution } from './scopeResolver.js';

// create_records / update_records on the standalone host. Same contract as the
// extension (src/agent/commands/bulk.ts): validated and given a batch id before
// any review, run row by row by the helper tab (agentRecordBatch) with a
// per-row ledger, collected again with get_batch_result.

export const BULK_COMMANDS = ['create_records', 'update_records'] as const;
export const ANSWER_GRACE_MS = 30_000;

export function bulkMode(command: string): BulkMode | null {
  return command === 'create_records' ? 'create' : command === 'update_records' ? 'update' : null;
}

function fail(code: string, message: string, details?: any): never {
  throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

/** Same rule as the extension (lostAnswer in src/agent/commands/bulk.ts). */
export function lostAnswer(batchId: string, err: any): Error {
  const cause = err?.code || 'E_INTERNAL';
  return Object.assign(new Error(
    `No answer for batch ${batchId} (${cause}). The helper tab may have written some or all rows: do not send this batch again. ` +
    `Once the helper tab is connected, call get_batch_result with this batchId and retry only rows it reports as not_attempted or failed.`,
  ), { code: 'E_TIMEOUT', details: { batchId, cause, retrySafe: false } });
}

/** The Table API answers 400 "Invalid table" for a table that does not exist. */
export function isMissingTable(status: unknown, message: unknown): boolean {
  return status === 400 && /invalid table/i.test(String(message || ''));
}

export async function prepareBulk(
  mode: BulkMode,
  params: any,
  resolveScope: (scope: unknown) => Promise<ScopeResolution>,
  tableProbe: (table: string) => Promise<{ status?: number; error?: string } | undefined>,
  columnsProbe: (table: string) => Promise<unknown> = async () => undefined,
): Promise<any> {
  const plan = validateBulkParams(mode, params);
  const probe = await tableProbe(plan.table).catch(() => undefined);
  if (isMissingTable(probe?.status, probe?.error)) {
    fail('E_INVALID_PARAMS', `Table "${plan.table}" does not exist on this instance.`);
  }
  // Compare rules for the written fields; without metadata the helper compares as text.
  const columns = await columnsProbe(plan.table).catch(() => undefined);
  const fieldKinds = fieldKindsFromMeta(columns, Array.from(new Set(plan.rows.flatMap((r) => Object.keys(r.fields)))));
  let scope: { transactionScope?: string; effectiveScope?: string } = {};
  if (mode === 'create' && (params?.scope !== undefined || plan.pinnedScopes.length > 0)) {
    const resolution = params?.scope !== undefined ? await resolveScope(params.scope) : undefined;
    scope = reconcileBulkScope(resolution, plan.pinnedScopes);
  }
  const { __batch, ...rest } = params || {};
  const batch: BulkBatch & { effectiveScope?: string } = {
    batchId: newBatchId(crypto.randomBytes(4).toString('hex')),
    mode,
    table: plan.table,
    rows: plan.rows,
    ...(scope.transactionScope ? { transactionScope: scope.transactionScope } : {}),
    ...(scope.effectiveScope ? { effectiveScope: scope.effectiveScope } : {}),
    continueOnError: plan.continueOnError,
    deadlineMs: plan.deadlineMs,
    ...(Object.keys(fieldKinds).length ? { fieldKinds } : {}),
  };
  return { ...rest, __batch: batch };
}

export function dryRunResult(batch: BulkBatch & { effectiveScope?: string }) {
  const n = batch.rows.length;
  return {
    dryRun: true,
    message: `Valid: ${n} row${n === 1 ? '' : 's'} would be ${batch.mode === 'create' ? 'created' : 'updated'} on ${batch.table}. Nothing was written, and business rules and ACLs are not checked by a dry run.`,
    table: batch.table,
    mode: batch.mode,
    ...(batch.effectiveScope ? { effectiveScope: batch.effectiveScope } : {}),
    ...(batch.transactionScope ? { transactionScope: batch.transactionScope } : {}),
    rows: batch.rows.map((r) => (r.sys_id ? { sys_id: r.sys_id, ...r.fields } : { ...r.fields })),
  };
}

/** The message the helper runs; effectiveScope is for the caller only. */
export function batchMessage(batch: BulkBatch & { effectiveScope?: string }) {
  const { effectiveScope, ...wire } = batch;
  return { action: 'agentRecordBatch', ...wire };
}

/** Same mapping as the extension: success, or the overall error with every row in details. */
export function batchResult(reply: any, expected: { batchId?: string; total?: number; table?: string; mode?: string; effectiveScope?: string }) {
  if (!reply || reply.success === false) {
    fail(reply?.code || 'E_COMMAND_FAILED', reply?.error || 'Record batch failed', { batchId: expected.batchId });
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
    const done = rows.filter((r) => r.outcome === 'succeeded' || r.outcome === 'failed').length;
    return { ...base, running: true, message: `Still running: ${done} of ${total} rows answered. Call get_batch_result again.`, rows };
  }
  const notRunCode = report.stopReason === 'deadline' ? 'E_TIMEOUT' : report.stopReason === 'session' ? 'E_TOKEN_EXPIRED' : 'E_COMMAND_FAILED';
  const summary = summarizeBulk(rows, notRunCode);
  const result = { ...base, running: false, counts: summary.counts, rows };
  if (summary.status === 'success') return { ...result, message: summary.message };
  fail(summary.code as string, summary.message, result);
}

export function expectedFor(batch: (BulkBatch & { effectiveScope?: string }) | undefined) {
  return { batchId: batch?.batchId, total: batch?.rows?.length, table: batch?.table, mode: batch?.mode, effectiveScope: batch?.effectiveScope };
}

export function requireBatchId(value: unknown): string {
  if (!isBatchId(value)) fail('E_INVALID_PARAMS', 'Missing or invalid param "batchId" (as returned by create_records / update_records)');
  return value as string;
}
