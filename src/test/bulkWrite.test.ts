import test from 'node:test';
import assert from 'node:assert';
import { validateBulkParams, reconcileBulkScope, summarizeBulk, normalizeRowResults, newBatchId, isBatchId, fieldKindsFromMeta } from '../agent/bulkWrite';
import { BULK_VALIDATE_VECTORS, BULK_SCOPE_VECTORS, BULK_SUMMARY_VECTORS, BULK_FIELD_KIND_VECTORS } from '../agent/bulkWriteVectors';

// The shared conformance tables. packages/snu runs the identical vectors against
// its mirrored copy: a rule changed in one host and not the other fails there.
for (const vector of BULK_VALIDATE_VECTORS) {
	test(`bulk validate vector: ${vector.name}`, () => {
		const run = () => validateBulkParams(vector.mode, vector.params);
		const expected = vector.expect;
		if (expected.ok === false) {
			const { messageIncludes } = expected;
			assert.throws(run, (err: any) => err.code === 'E_INVALID_PARAMS' && String(err.message).includes(messageIncludes));
			return;
		}
		const plan = run();
		assert.strictEqual(plan.rows.length, expected.rows);
		assert.deepStrictEqual(plan.rows.map(r => r.index), plan.rows.map((_, i) => i));
		if (expected.continueOnError !== undefined) assert.strictEqual(plan.continueOnError, expected.continueOnError);
		if (expected.dryRun !== undefined) assert.strictEqual(plan.dryRun, expected.dryRun);
		if (expected.deadlineMs !== undefined) assert.strictEqual(plan.deadlineMs, expected.deadlineMs);
		if (expected.pinnedScopes) assert.deepStrictEqual(plan.pinnedScopes, expected.pinnedScopes);
		if (expected.firstSysId) {
			assert.strictEqual(plan.rows[0].sys_id, expected.firstSysId);
			assert.ok(!('sys_id' in plan.rows[0].fields));
		}
	});
}

for (const vector of BULK_SCOPE_VECTORS) {
	test(`bulk scope vector: ${vector.name}`, () => {
		const run = () => reconcileBulkScope(vector.batch, vector.pinned);
		if (!vector.expect.ok) {
			assert.throws(run, (err: any) => err.code === 'E_INVALID_PARAMS');
			return;
		}
		assert.deepStrictEqual(run(), Object.fromEntries(Object.entries({
			transactionScope: vector.expect.transactionScope, effectiveScope: vector.expect.effectiveScope,
		}).filter(([, v]) => v !== undefined)));
	});
}

for (const vector of BULK_SUMMARY_VECTORS) {
	test(`bulk summary vector: ${vector.name}`, () => {
		const summary = summarizeBulk(vector.outcomes.map((outcome, index) => ({ index, outcome })), vector.notRunCode);
		assert.strictEqual(summary.status, vector.expect.status);
		assert.strictEqual(summary.code, vector.expect.code);
		assert.strictEqual(summary.counts.total, vector.outcomes.length);
	});
}

test('a damaged ledger reports missing rows as unknown, never as written or safe to retry', () => {
	const rows = normalizeRowResults(3, [{ index: 0, outcome: 'succeeded', sys_id: 'a'.repeat(32) }, { index: 2, outcome: 'bogus' }]);
	assert.deepStrictEqual(rows.map(r => r.outcome), ['succeeded', 'unknown', 'unknown']);
	assert.strictEqual(rows[0].sys_id, 'a'.repeat(32));
});

test('batch ids are host-assigned and recognisable', () => {
	const id = newBatchId('ABCDEF0123', 1_700_000_000_000);
	assert.ok(isBatchId(id), id);
	assert.ok(!isBatchId('bat_x'));
	assert.ok(!isBatchId('rev_123_abcdef'));
});

for (const vector of BULK_FIELD_KIND_VECTORS) {
	test(`bulk field kind vector: ${vector.name}`, () => {
		assert.deepStrictEqual(fieldKindsFromMeta(vector.columns, vector.fields), vector.expect);
	});
}

test('row warnings survive normalization; malformed ones are dropped, never invented', () => {
	const rows = normalizeRowResults(2, [
		{ index: 0, outcome: 'succeeded', warnings: [{ field: 'ui_policy', issue: 'empty' }, { field: 'a.b', issue: 'empty' }, { field: 'x', issue: 'bogus' }, 'junk'] },
		{ index: 1, outcome: 'succeeded', warnings: [] },
	]);
	assert.deepStrictEqual(rows[0].warnings, [{ field: 'ui_policy', issue: 'empty' }]);
	assert.ok(!('warnings' in rows[1]));
	const summary = summarizeBulk(rows);
	assert.strictEqual(summary.status, 'success', 'a written row with warnings is still written');
	assert.strictEqual(summary.counts.withWarnings, 1);
	assert.match(summary.message, /do not create those rows again/);
});
