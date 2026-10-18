/**
 * Multi-record writes (create_records / update_records): request validation,
 * scope reconciliation and the per-row outcome contract.
 *
 * Bulk work used to reach the instance through rest_request batch calls or a
 * GlideRecord loop in a background script, both of which the helper tab sees as
 * one opaque write. These commands keep every row visible: one review card for
 * the batch, one write-history entry per record, and an outcome for every input
 * row so an agent can recover without guessing which rows exist.
 *
 * Pure logic, no imports: the standalone bridge mirrors this file verbatim (packages/snu/src/server/bulkWrite.ts)
 * (the CLI and the extension are separate builds, as with scopeResolver.ts),
 * and both suites run the same vectors in bulkWriteVectors.ts.
 */

export const BULK_MAX_ROWS = 200;
/** Serialized size of all rows together. Rows with large script fields make
 * the row count a poor limit on its own. */
export const BULK_MAX_PAYLOAD_BYTES = 1_000_000;
export const BULK_DEFAULT_DEADLINE_MINUTES = 10;
export const BULK_MAX_DEADLINE_MINUTES = 30;

export type BulkMode = 'create' | 'update';

export interface BulkRow {
	/** Position in the caller's rows[]; every outcome is reported by it. */
	index: number;
	/** update: the record to change. create: an optional sys_id to insert with. */
	sys_id?: string;
	fields: Record<string, any>;
}

/** What the helper tab executes, and what a review card shows. */
export interface BulkBatch {
	batchId: string;
	mode: BulkMode;
	table: string;
	rows: BulkRow[];
	/** sysparm_transaction_scope for every row; omitted means the session decides. */
	transactionScope?: string;
	continueOnError: boolean;
	deadlineMs: number;
	/**
	 * How the helper compares each written field with the record the instance
	 * answered with (see fieldKindsFromMeta). Absent when the column metadata
	 * could not be read: every field is then compared as text.
	 */
	fieldKinds?: Record<string, FieldKind>;
}

/**
 * Compare rule per column type. `skip`: the Table API answer cannot show what
 * was stored (journal, password, encrypted fields), so the field is reported
 * as unverified instead of compared.
 */
export type FieldKind = 'text' | 'bool' | 'number' | 'list' | 'skip';

/** Why a written field could not be confirmed. The row stays succeeded. */
export type FieldIssue = 'empty' | 'different' | 'unverified';

export interface FieldWarning {
	field: string;
	issue: FieldIssue;
}

export interface BulkPlan {
	mode: BulkMode;
	table: string;
	rows: BulkRow[];
	continueOnError: boolean;
	deadlineMs: number;
	dryRun: boolean;
	/** Distinct fields.sys_scope values the create rows pinned ('global' or a lowercase sys_id). */
	pinnedScopes: string[];
}

export type RowOutcome = 'succeeded' | 'failed' | 'not_attempted' | 'unknown';

export interface RowResult {
	index: number;
	outcome: RowOutcome;
	sys_id?: string;
	status?: number;
	error?: string;
	/** Fields the instance answered with empty, a different value, or not at all. */
	warnings?: FieldWarning[];
}

export interface BulkSummary {
	status: 'success' | 'error';
	code?: string;
	message: string;
	counts: { total: number; succeeded: number; failed: number; notAttempted: number; unknown: number; withWarnings: number };
}

export interface BulkError extends Error {
	code: 'E_INVALID_PARAMS';
}

const TABLE_NAME = /^[a-zA-Z0-9_]+$/;
const FIELD_NAME = /^[a-zA-Z0-9_]+$/;
const SYS_ID = /^[0-9a-f]{32}$/i;
const BATCH_ID = /^bat_[a-z0-9]+_[a-f0-9]{6,32}$/;

function fail(message: string): never {
	throw Object.assign(new Error(message), { code: 'E_INVALID_PARAMS' as const });
}

function isPlainObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Host-assigned id, so a batch is addressable before review (and with no review at all). */
export function newBatchId(randomHex: string, now: number = Date.now()): string {
	const hex = String(randomHex).toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 32);
	return `bat_${now.toString(36)}_${hex.padEnd(6, '0')}`;
}

export function isBatchId(value: unknown): value is string {
	return typeof value === 'string' && BATCH_ID.test(value);
}

/**
 * Validate a create_records / update_records request. Throws E_INVALID_PARAMS
 * with the offending row index; nothing is written and no review is raised
 * for a request that fails here.
 */
export function validateBulkParams(mode: BulkMode, params: any): BulkPlan {
	const p = isPlainObject(params) ? params : {};
	const table = typeof p.table === 'string' ? p.table.trim() : '';
	if (!table || !TABLE_NAME.test(table)) {
		fail('Missing or invalid param "table" (must be alphanumeric/underscore)');
	}
	if (!Array.isArray(p.rows) || p.rows.length === 0) {
		fail('Missing required param "rows": an array of field objects, one per record');
	}
	if (p.rows.length > BULK_MAX_ROWS) {
		fail(`Too many rows: ${p.rows.length}. The limit is ${BULK_MAX_ROWS} per call; send the rest in further calls.`);
	}
	let size = 0;
	try { size = JSON.stringify(p.rows).length; } catch { fail('rows must be plain JSON'); }
	if (size > BULK_MAX_PAYLOAD_BYTES) {
		fail(`rows are ${size} bytes of JSON. The limit is ${BULK_MAX_PAYLOAD_BYTES}; send fewer rows per call.`);
	}
	if (p.continueOnError !== undefined && typeof p.continueOnError !== 'boolean') {
		fail('continueOnError must be true or false');
	}
	if (p.dryRun !== undefined && typeof p.dryRun !== 'boolean') {
		fail('dryRun must be true or false');
	}
	let deadlineMinutes = BULK_DEFAULT_DEADLINE_MINUTES;
	if (p.deadlineMinutes !== undefined) {
		const n = Number(p.deadlineMinutes);
		if (!Number.isFinite(n) || n < 1 || n > BULK_MAX_DEADLINE_MINUTES) {
			fail(`deadlineMinutes must be between 1 and ${BULK_MAX_DEADLINE_MINUTES}`);
		}
		deadlineMinutes = n;
	}
	if (mode === 'update' && p.scope !== undefined) {
		fail('update_records takes no "scope": each record is written in its own application scope');
	}

	const rows: BulkRow[] = [];
	const pinned = new Set<string>();
	const seen = new Set<string>();
	p.rows.forEach((raw: unknown, index: number) => {
		if (!isPlainObject(raw)) fail(`Row ${index} is not an object of field values`);
		const fields: Record<string, any> = { ...raw };
		for (const name of Object.keys(fields)) {
			if (!FIELD_NAME.test(name)) fail(`Row ${index} has an invalid field name "${name}"`);
		}
		let sysId: string | undefined;
		if ('sys_id' in fields) {
			const value = typeof fields.sys_id === 'string' ? fields.sys_id.trim() : '';
			if (!SYS_ID.test(value)) fail(`Row ${index} has an invalid sys_id (32 hex characters expected)`);
			sysId = value.toLowerCase();
			delete fields.sys_id;
			if (seen.has(sysId)) fail(`Row ${index} repeats sys_id ${sysId}; each record may appear once per call`);
			seen.add(sysId);
		}
		if (mode === 'update') {
			if (!sysId) fail(`Row ${index} has no sys_id: update_records needs the record to change`);
			if (Object.keys(fields).length === 0) fail(`Row ${index} has no fields to write`);
			if ('sys_scope' in fields) {
				fail(`Row ${index} sets sys_scope, which is read-only after insert. Unlike update_record_batch, update_records rejects it instead of dropping it.`);
			}
		} else if ('sys_scope' in fields) {
			const value = typeof fields.sys_scope === 'string' ? fields.sys_scope.trim().toLowerCase() : '';
			if (value !== 'global' && !SYS_ID.test(value)) {
				fail(`Row ${index} has fields.sys_scope "${fields.sys_scope}": use a sys_id or 'global', or pass the application name as the batch "scope"`);
			}
			pinned.add(value);
		}
		// A create with only a sys_id inserts an empty record with that id, which
		// is legitimate on a table without required columns.
		if (Object.keys(fields).length === 0 && !sysId) fail(`Row ${index} has no fields to write`);
		rows.push({ index, ...(sysId ? { sys_id: sysId } : {}), fields });
	});

	return {
		mode,
		table,
		rows,
		continueOnError: p.continueOnError === true,
		deadlineMs: Math.round(deadlineMinutes * 60_000),
		dryRun: p.dryRun === true,
		pinnedScopes: Array.from(pinned),
	};
}

/**
 * Pick the one transaction scope a create batch runs in.
 *
 * The batch "scope" is the transaction scope, exactly as on create_record, and
 * is resolved by the host (name or sys_id) before this runs. A row's own
 * fields.sys_scope is left as written. The only rule added for batches: every
 * stated scope, batch and rows, must name the same application, compared by
 * resolved identity and never by string.
 */
export function reconcileBulkScope(
	batch: { specified: boolean; sysScopeId?: string; effectiveScope?: string } | undefined,
	pinnedScopes: string[],
): { transactionScope?: string; effectiveScope?: string } {
	const identities = new Set<string>(pinnedScopes);
	if (batch?.specified) identities.add(batch.sysScopeId ? batch.sysScopeId.toLowerCase() : 'global');
	if (identities.size > 1) {
		fail(`The batch scope and the rows' fields.sys_scope name different applications (${Array.from(identities).join(', ')}). One call writes in one scope.`);
	}
	const only = identities.size === 1 ? Array.from(identities)[0] : undefined;
	if (!only) return {};
	if (only === 'global') return { effectiveScope: 'global' };
	return {
		transactionScope: only,
		effectiveScope: batch?.specified && batch.sysScopeId?.toLowerCase() === only ? (batch.effectiveScope || only) : only,
	};
}

/**
 * Overall status for a finished (or interrupted) batch.
 *
 * | rows                                         | result             |
 * |----------------------------------------------|--------------------|
 * | all succeeded                                | success            |
 * | some succeeded                               | E_PARTIAL_FAILURE  |
 * | none succeeded, at least one unknown         | E_TIMEOUT          |
 * | none succeeded, at least one failed          | E_COMMAND_FAILED   |
 * | nothing attempted                            | notRunCode         |
 */
export function summarizeBulk(rows: RowResult[], notRunCode = 'E_COMMAND_FAILED'): BulkSummary {
	const counts = { total: rows.length, succeeded: 0, failed: 0, notAttempted: 0, unknown: 0, withWarnings: 0 };
	for (const row of rows) {
		if (row.warnings && row.warnings.length) counts.withWarnings++;
		if (row.outcome === 'succeeded') counts.succeeded++;
		else if (row.outcome === 'failed') counts.failed++;
		else if (row.outcome === 'unknown') counts.unknown++;
		else counts.notAttempted++;
	}
	const tail = `${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.unknown} unknown, ${counts.notAttempted} not attempted.`;
	const warned = counts.withWarnings
		? ` ${counts.withWarnings} written row${counts.withWarnings === 1 ? '' : 's'} came back with fields that do not match what was sent (rows[].warnings: empty, different, unverified); check them before relying on the values, and do not create those rows again.`
		: '';
	if (counts.total > 0 && counts.succeeded === counts.total) {
		return { status: 'success', message: `All ${counts.total} rows succeeded.${warned}`, counts };
	}
	const advice = counts.unknown
		? ' Rows marked unknown were sent without an answer: query the table before retrying them, or a create may run twice.'
		: '';
	if (counts.succeeded > 0) {
		return { status: 'error', code: 'E_PARTIAL_FAILURE', message: `Batch partly written: ${tail} Succeeded rows are not rolled back; retry only the rows that did not succeed.${advice}${warned}`, counts };
	}
	if (counts.unknown > 0) {
		return { status: 'error', code: 'E_TIMEOUT', message: `No row is confirmed written: ${tail}${advice}`, counts };
	}
	if (counts.failed > 0) {
		return { status: 'error', code: 'E_COMMAND_FAILED', message: `No row was written: ${tail} See rows[] for each error.`, counts };
	}
	return { status: 'error', code: notRunCode, message: `No row was attempted: ${tail}`, counts };
}

const OUTCOMES: RowOutcome[] = ['succeeded', 'failed', 'not_attempted', 'unknown'];
const FIELD_ISSUES: FieldIssue[] = ['empty', 'different', 'unverified'];

/**
 * Compare rules for the written fields, from the table's column metadata
 * (`/api/now/ui/meta/<table>` columns: `{ name: { internal_type } }`). Fields
 * the metadata does not know are left out: the helper compares them as text,
 * and a field missing from the answer is reported as unverified anyway.
 */
export function fieldKindsFromMeta(columns: unknown, fieldNames: string[]): Record<string, FieldKind> {
	const kinds: Record<string, FieldKind> = {};
	if (!isPlainObject(columns)) return kinds;
	for (const name of fieldNames) {
		const col = (columns as Record<string, any>)[name];
		if (!isPlainObject(col)) continue;
		const type = String(col.internal_type || col.type || '').toLowerCase();
		if (/^journal|password|encrypted|^related_tags$|^user_input$|^glide_duration$|^timer$/.test(type)) kinds[name] = 'skip';
		else if (type === 'boolean') kinds[name] = 'bool';
		else if (/^(integer|decimal|float|longint|currency|price|percent_complete|order_index)$/.test(type)) kinds[name] = 'number';
		else if (type === 'glide_list') kinds[name] = 'list';
		else kinds[name] = 'text';
	}
	return kinds;
}

/**
 * Normalize the helper tab's ledger into one result per input row. Anything
 * missing or malformed for an index is reported as unknown, never as
 * succeeded or not attempted, so a damaged ledger can only make the agent
 * more careful.
 */
export function normalizeRowResults(total: number, raw: unknown): RowResult[] {
	const byIndex = new Map<number, any>();
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (isPlainObject(entry) && Number.isInteger(entry.index)) byIndex.set(entry.index, entry);
		}
	}
	const out: RowResult[] = [];
	for (let index = 0; index < total; index++) {
		const entry = byIndex.get(index);
		const outcome: RowOutcome = entry && OUTCOMES.includes(entry.outcome) ? entry.outcome : 'unknown';
		const row: RowResult = { index, outcome };
		if (typeof entry?.sys_id === 'string' && SYS_ID.test(entry.sys_id)) row.sys_id = entry.sys_id;
		if (Number.isInteger(entry?.status)) row.status = entry.status;
		if (typeof entry?.error === 'string' && entry.error) row.error = entry.error.slice(0, 500);
		if (Array.isArray(entry?.warnings)) {
			const warnings = entry.warnings
				.filter((w: any) => isPlainObject(w) && typeof w.field === 'string' && FIELD_NAME.test(w.field) && FIELD_ISSUES.includes(w.issue))
				.slice(0, 200)
				.map((w: any) => ({ field: w.field, issue: w.issue as FieldIssue }));
			if (warnings.length) row.warnings = warnings;
		}
		out.push(row);
	}
	return out;
}
