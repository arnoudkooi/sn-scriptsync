import test from 'node:test';
import assert from 'node:assert';
import { createHarness, stubVscode } from './helpers/commandHarness';

// Multi-record writes (create_records / update_records) through the real
// dispatcher: validated before any review, staged before any review in review
// mode, one review for the batch, and an outcome per row.

const harness = createHarness('bulkinst');
const vscodeStub = stubVscode(harness.workspaceRoot);
vscodeStub.extensions = { getExtension: () => ({ packageJSON: { version: '0.0.0-test' } }) };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dispatchAgentCommand } = require('../agent/dispatcher');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRuntime } = require('../agent/runtime');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pendingRegistry = require('../agent/pendingRegistry');

const INSTANCE = 'bulkinst';
const A = '0123456789abcdef0123456789abcdef';
const B = '1123456789abcdef0123456789abcdef';
const APP = 'c1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const GATES = { backgroundScripts: 'off', deleteRecords: 'off', createArtifacts: 'auto', updateRecords: 'auto', browserDebugger: 'off', restRequest: 'off' };

function useRuntime(options: { gates?: Record<string, any>; capabilities?: Record<string, any>; reviewWrites?: boolean; staged?: any[] } = {}) {
	const staged = options.staged || [];
	setRuntime({
		sendToBrowser: (payload: any) => {
			harness.sent.push(payload);
			// Reads made while preparing a batch: scope lookup and table probe.
			if (payload.action === 'agentRestApi' && payload.method === 'GET') {
				if (payload.endpoint === '/api/now/table/sys_scope') {
					pendingRegistry.resolve(payload.agentRequestId, { success: true, status: 200, data: { result: [{ sys_id: APP, scope: 'x_app' }] } });
				} else if (payload.endpoint === '/api/now/ui/meta/incident') {
					pendingRegistry.resolve(payload.agentRequestId, { success: true, status: 200, data: { result: { columns: { urgency: { internal_type: 'integer' }, work_notes: { internal_type: 'journal_input' } } } } });
				} else if (payload.endpoint === '/api/now/table/no_such_table') {
					pendingRegistry.resolve(payload.agentRequestId, { success: false, status: 400, error: 'Invalid table no_such_table' });
				} else {
					pendingRegistry.resolve(payload.agentRequestId, { success: true, status: 200, data: { result: [] } });
				}
			}
		},
		hasBrowserClient: () => true,
		isServerRunning: () => true,
		log: () => { /* quiet */ },
		reviewWritesEnabled: () => options.reviewWrites === true,
		stageAgentWrite: (input: any) => {
			staged.push(input);
			return { staged: true, reviewId: 'rev_test', message: 'held' };
		},
		getHelperBuildInfo: () => ({
			capabilities: options.capabilities ?? { instanceSecurityGates: 1, commandReview: 1, recordBatch: 1 },
		}),
		getInstanceGates: () => ({ ...GATES, ...(options.gates || {}) }),
	});
	return staged;
}

function request(command: string, params: any = {}, id = 'bulk_1') {
	return { id, command, instance: INSTANCE, params, timestamp: Date.now() };
}

async function sentMessage(action: string) {
	for (let i = 0; i < 200 && !harness.sent.some((m) => m.action === action); i++) {
		await new Promise((r) => setImmediate(r));
	}
	const msg = harness.sent.find((m) => m.action === action);
	assert.ok(msg, `expected a ${action} message`);
	return msg;
}


const ledger = (batch: any, rows: any[], extra: any = {}) => ({
	success: true,
	batch: { batchId: batch.batchId, mode: batch.mode, table: batch.table, total: batch.rows.length, running: false, rows, ...extra },
});

test.afterEach(() => { harness.sent.length = 0; });
test.after(() => harness.cleanup());

test('invalid rows are refused before anything is reviewed or sent', async () => {
	useRuntime({ gates: { createArtifacts: 'approve' } });
	const resp = await dispatchAgentCommand(request('create_records', { table: 'sys_choice', rows: [{ label: 'a' }, {}] }));
	assert.strictEqual(resp.code, 'E_INVALID_PARAMS');
	assert.match(resp.error, /Row 1/);
	assert.strictEqual(harness.sent.length, 0);
});

test('an approve gate raises one review with the validated batch and its id', async () => {
	useRuntime({ gates: { createArtifacts: 'approve' } });
	const pending = dispatchAgentCommand(request('create_records', {
		table: 'sys_choice', scope: 'x_app', rows: [{ label: 'a', sys_scope: APP }, { label: 'b' }],
		// A caller cannot hand in its own plan.
		__batch: { batchId: 'bat_x_000000', rows: [{ index: 0, fields: { evil: 1 } }] },
	}));
	const resp = await pending;
	assert.strictEqual(resp.code, 'E_REVIEW_PENDING');
	const review = await sentMessage('reviewRequest');
	assert.strictEqual(review.reviewKind, 'record_batch');
	const batch = review.params.__batch;
	assert.notStrictEqual(batch.batchId, 'bat_x_000000');
	assert.strictEqual(resp.details.batchId, batch.batchId);
	assert.strictEqual(batch.transactionScope, APP);
	assert.deepStrictEqual(batch.rows.map((r: any) => r.fields.label), ['a', 'b']);
	assert.ok(!harness.sent.some((m) => m.action === 'agentRecordBatch'), 'nothing ran before approval');
	pendingRegistry.reject(review.agentRequestId, 'E_USER_REJECTED', 'test teardown');
	await new Promise((r) => setImmediate(r));
});

test('a batch scope and a row scope naming different applications is refused', async () => {
	useRuntime();
	const pending = dispatchAgentCommand(request('create_records', {
		table: 'sys_choice', scope: 'x_app', rows: [{ label: 'a', sys_scope: B }],
	}));
	const resp = await pending;
	assert.strictEqual(resp.code, 'E_INVALID_PARAMS');
	assert.ok(!harness.sent.some((m) => m.action === 'agentRecordBatch'));
});

test('dryRun validates without a review or a write, also behind an approve gate', async () => {
	useRuntime({ gates: { updateRecords: 'approve' } });
	const resp = await dispatchAgentCommand(request('update_records', { table: 'incident', dryRun: true, rows: [{ sys_id: A, urgency: '2' }] }));
	assert.strictEqual(resp.status, 'success', resp.error);
	assert.strictEqual(resp.result.dryRun, true);
	assert.deepStrictEqual(resp.result.rows, [{ sys_id: A, urgency: '2' }]);
	assert.ok(!harness.sent.some((m) => m.action === 'agentRecordBatch' || m.action === 'reviewRequest'));
});

test('auto: the helper runs the batch and every row comes back, partial failure keeps the rows', async () => {
	useRuntime();
	const pending = dispatchAgentCommand(request('update_records', { table: 'incident', rows: [{ sys_id: A, urgency: '2' }, { sys_id: B, urgency: '3' }] }));
	const msg = await sentMessage('agentRecordBatch');
	assert.strictEqual(msg.mode, 'update');
	assert.strictEqual(msg.rows.length, 2);
	assert.ok(!('effectiveScope' in msg));
	pendingRegistry.resolve(msg.agentRequestId, ledger(msg, [
		{ index: 0, outcome: 'succeeded', status: 200, sys_id: A },
		{ index: 1, outcome: 'failed', status: 403, error: 'ACL' },
	]));
	const resp = await pending;
	assert.strictEqual(resp.code, 'E_PARTIAL_FAILURE');
	assert.strictEqual(resp.details.batchId, msg.batchId);
	assert.deepStrictEqual(resp.details.rows.map((r: any) => r.outcome), ['succeeded', 'failed']);
	assert.match(resp.error, /not rolled back/);
});

test('auto: all rows written is a success with counts', async () => {
	useRuntime();
	const pending = dispatchAgentCommand(request('create_records', { table: 'sys_choice', rows: [{ label: 'a' }] }));
	const msg = await sentMessage('agentRecordBatch');
	pendingRegistry.resolve(msg.agentRequestId, ledger(msg, [{ index: 0, outcome: 'succeeded', status: 201, sys_id: A }]));
	const resp = await pending;
	assert.strictEqual(resp.status, 'success', resp.error);
	assert.strictEqual(resp.result.counts.succeeded, 1);
	assert.strictEqual(resp.result.rows[0].sys_id, A);
});

test('an older helper without record batches is refused, not sent rows it would run without a card', async () => {
	useRuntime({ capabilities: { instanceSecurityGates: 1, commandReview: 1 } });
	const resp = await dispatchAgentCommand(request('create_records', { table: 'sys_choice', rows: [{ label: 'a' }] }));
	assert.strictEqual(resp.code, 'E_UNSUPPORTED_HOST');
	assert.ok(!harness.sent.some((m) => m.action === 'agentRecordBatch'));
});

test('an older helper behind an approve gate is refused before any review card', async () => {
	useRuntime({ gates: { createArtifacts: 'approve' }, capabilities: { instanceSecurityGates: 1, commandReview: 1 } });
	const resp = await dispatchAgentCommand(request('create_records', { table: 'sys_choice', rows: [{ label: 'a' }] }));
	assert.strictEqual(resp.code, 'E_UNSUPPORTED_HOST');
	assert.ok(!harness.sent.some((m) => m.action === 'reviewRequest' || m.action === 'agentRecordBatch'));
});

test('review mode stages the batch first; the replay is re-validated and only then reviewed', async () => {
	const staged = useRuntime({ gates: { createArtifacts: 'approve' }, reviewWrites: true });
	const first = await dispatchAgentCommand(request('create_records', { table: 'sys_choice', rows: [{ label: 'a' }, { label: 'b' }] }));
	assert.strictEqual(first.status, 'success', first.error);
	assert.strictEqual(first.result.staged, true);
	assert.ok(first.result.batchId);
	assert.strictEqual(staged.length, 1);
	assert.ok(!harness.sent.some((m) => m.action === 'reviewRequest'), 'no helper review before the user saw the rows');

	// Sync Now replays the rows as the user left them (one dropped, one edited).
	const original = staged[0].request.params;
	const bad = await dispatchAgentCommand({ ...request('create_records', { ...original, rows: [{}], __batch: { batchId: original.__batch.batchId }, __review_bypass: true }, 'bulk_replay_bad') }, { internal: true });
	assert.strictEqual(bad.code, 'E_INVALID_PARAMS', 'an edited payload is validated again');

	const replay = await dispatchAgentCommand({ ...request('create_records', { ...original, rows: [{ label: 'b2' }], __batch: { batchId: original.__batch.batchId }, __review_bypass: true }, 'bulk_replay') }, { internal: true });
	assert.strictEqual(replay.code, 'E_REVIEW_PENDING');
	const review = await sentMessage('reviewRequest');
	assert.strictEqual(review.params.__batch.batchId, first.result.batchId, 'the staged batch keeps its id');
	assert.deepStrictEqual(review.params.__batch.rows.map((r: any) => r.fields.label), ['b2']);
	pendingRegistry.reject(review.agentRequestId, 'E_USER_REJECTED', 'test teardown');
	await new Promise((r) => setImmediate(r));
});

test('get_batch_result reports a running batch, then the final outcome', async () => {
	useRuntime();
	const batchId = 'bat_abc123_a1b2c3d4';
	let pending = dispatchAgentCommand(request('get_batch_result', { batchId }));
	let msg = await sentMessage('agentBatchResult');
	pendingRegistry.resolve(msg.agentRequestId, { success: true, batch: { batchId, mode: 'create', table: 't', total: 2, running: true, rows: [{ index: 0, outcome: 'succeeded' }] } });
	let resp = await pending;
	assert.strictEqual(resp.status, 'success');
	assert.strictEqual(resp.result.running, true);
	harness.sent.length = 0;

	pending = dispatchAgentCommand(request('get_batch_result', { batchId }, 'bulk_2'));
	msg = await sentMessage('agentBatchResult');
	pendingRegistry.resolve(msg.agentRequestId, { success: true, batch: { batchId, mode: 'create', table: 't', total: 2, running: false, interrupted: true, rows: [{ index: 0, outcome: 'unknown' }, { index: 1, outcome: 'not_attempted' }] } });
	resp = await pending;
	assert.strictEqual(resp.code, 'E_TIMEOUT');
	assert.match(resp.error, /query the table before retrying/);
});

test('get_batch_result refuses an invalid id without asking the helper', async () => {
	useRuntime();
	const resp = await dispatchAgentCommand(request('get_batch_result', { batchId: 'rev_123' }));
	assert.strictEqual(resp.code, 'E_INVALID_PARAMS');
	assert.ok(!harness.sent.some((m) => m.action === 'agentBatchResult'));
});

test('after approval the helper\'s answer is mapped like a direct run, per row', async () => {
	useRuntime({ gates: { updateRecords: 'approve' } });
	const resp = await dispatchAgentCommand(request('update_records', { table: 'incident', rows: [{ sys_id: A, urgency: '2' }, { sys_id: B, urgency: '3' }] }, 'bulk_approved'));
	assert.strictEqual(resp.code, 'E_REVIEW_PENDING');
	const review = await sentMessage('reviewRequest');
	const batch = review.params.__batch;
	pendingRegistry.resolve(review.agentRequestId, ledger(batch, [
		{ index: 0, outcome: 'succeeded', status: 200 },
		{ index: 1, outcome: 'unknown', error: 'aborted' },
	]));
	const result = await dispatchAgentCommand(request('get_review_result', { reviewId: resp.details.reviewId, waitSeconds: 1 }, 'bulk_collect'));
	assert.strictEqual(result.code, 'E_PARTIAL_FAILURE', result.error);
	assert.deepStrictEqual(result.details.rows.map((r: any) => r.outcome), ['succeeded', 'unknown']);
	assert.strictEqual(result.details.batchId, batch.batchId);
});

test('a table that does not exist is refused, also on a dry run', async () => {
	useRuntime();
	const resp = await dispatchAgentCommand(request('create_records', { table: 'no_such_table', dryRun: true, rows: [{ a: 1 }] }));
	assert.strictEqual(resp.code, 'E_INVALID_PARAMS');
	assert.match(resp.error, /does not exist/);
	assert.ok(!harness.sent.some((m) => m.action === 'agentRecordBatch'));
});

test('a lost answer after sending keeps the batchId and is never reported as safe to retry', async () => {
	useRuntime();
	const pending = dispatchAgentCommand(request('create_records', { table: 'sys_choice', rows: [{ label: 'a' }] }, 'bulk_lost'));
	const msg = await sentMessage('agentRecordBatch');
	pendingRegistry.reject(msg.agentRequestId, 'E_BROWSER_DISCONNECTED', 'Browser helper disconnected.');
	const resp = await pending;
	assert.strictEqual(resp.code, 'E_TIMEOUT');
	assert.strictEqual(resp.details.batchId, msg.batchId);
	assert.strictEqual(resp.details.retrySafe, false);
	assert.strictEqual(resp.details.cause, 'E_BROWSER_DISCONNECTED');
	assert.match(resp.error, /get_batch_result/);
	assert.match(resp.error, /do not send this batch again/);
});

test('a lost answer after approval keeps the batchId; a rejection stays a rejection', async () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { markReviewRunning } = require('../agent/reviewRegistry');
	useRuntime({ gates: { createArtifacts: 'approve' } });
	let resp = await dispatchAgentCommand(request('create_records', { table: 'sys_choice', rows: [{ label: 'a' }] }, 'bulk_appr_lost'));
	let review = await sentMessage('reviewRequest');
	markReviewRunning(resp.details.reviewId);
	pendingRegistry.reject(review.agentRequestId, 'E_BROWSER_DISCONNECTED', 'gone');
	let result = await dispatchAgentCommand(request('get_review_result', { reviewId: resp.details.reviewId, waitSeconds: 1 }, 'bulk_appr_lost_r'));
	assert.strictEqual(result.code, 'E_TIMEOUT');
	assert.strictEqual(result.details.batchId, review.params.__batch.batchId);
	harness.sent.length = 0;

	resp = await dispatchAgentCommand(request('create_records', { table: 'sys_choice', rows: [{ label: 'a' }] }, 'bulk_appr_rej'));
	review = await sentMessage('reviewRequest');
	pendingRegistry.reject(review.agentRequestId, 'E_USER_REJECTED', 'no');
	result = await dispatchAgentCommand(request('get_review_result', { reviewId: resp.details.reviewId, waitSeconds: 1 }, 'bulk_appr_rej_r'));
	assert.strictEqual(result.code, 'E_USER_REJECTED');
});

test('Sync Now keeps a staged batch until it has run, and requeues only rows that can be retried', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { stagedBatchDecision } = require('../agent/commands/bulk');
	const edited = [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }];
	assert.strictEqual(stagedBatchDecision({ status: 'error', code: 'E_INVALID_PARAMS' }, edited).action, 'keep');
	assert.strictEqual(stagedBatchDecision({ status: 'error', code: 'E_USER_REJECTED', details: { userFeedback: 'x' } }, edited).action, 'keep');
	assert.strictEqual(stagedBatchDecision({ status: 'error', code: 'E_TIMEOUT', details: { batchId: 'bat_x_a1b2c3', retrySafe: false } }, edited).action, 'keep');
	assert.strictEqual(stagedBatchDecision({ status: 'error', code: 'E_REVIEW_PENDING', details: { reviewId: 'r' } }, edited).action, 'keep');
	assert.strictEqual(stagedBatchDecision({ status: 'success', result: { running: true, rows: [] } }, edited).action, 'keep');
	assert.deepStrictEqual(stagedBatchDecision({ status: 'success', result: { rows: edited.map((_, index) => ({ index, outcome: 'succeeded' })) } }, edited),
		{ action: 'done', retryRows: [], unknown: 0 });
	assert.deepStrictEqual(stagedBatchDecision({ status: 'error', code: 'E_PARTIAL_FAILURE', details: { rows: [
		{ index: 0, outcome: 'succeeded' }, { index: 1, outcome: 'failed' }, { index: 2, outcome: 'unknown' }, { index: 3, outcome: 'not_attempted' },
	] } }, edited), { action: 'retry', retryRows: [{ label: 'b' }, { label: 'd' }], unknown: 1 });
});

test('compare rules from the column types reach the helper, and field warnings reach the caller', async () => {
	useRuntime();
	const pending = dispatchAgentCommand(request('update_records', { table: 'incident', rows: [{ sys_id: A, urgency: '2', work_notes: 'x', u_other: 'y' }] }, 'bulk_warn'));
	const msg = await sentMessage('agentRecordBatch');
	assert.deepStrictEqual(msg.fieldKinds, { urgency: 'number', work_notes: 'skip' });
	pendingRegistry.resolve(msg.agentRequestId, ledger(msg, [{ index: 0, outcome: 'succeeded', status: 200, sys_id: A,
		warnings: [{ field: 'urgency', issue: 'empty' }, { field: 'work_notes', issue: 'unverified' }] }]));
	const resp = await pending;
	assert.strictEqual(resp.status, 'success', 'a written row with warnings is still a success');
	assert.deepStrictEqual(resp.result.rows[0].warnings, [{ field: 'urgency', issue: 'empty' }, { field: 'work_notes', issue: 'unverified' }]);
	assert.strictEqual(resp.result.counts.withWarnings, 1);
	assert.match(resp.result.message, /rows\[\]\.warnings/);
});
