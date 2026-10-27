import test from 'node:test';
import assert from 'node:assert';
import { createHarness, stubVscode } from './helpers/commandHarness';

// The stub must be installed before the dispatcher (and everything it pulls in)
// is loaded, because those modules import `vscode` at require time.
const harness = createHarness('gateinst');
const vscodeStub = stubVscode(harness.workspaceRoot);
vscodeStub.extensions = { getExtension: () => ({ packageJSON: { version: '0.0.0-test' } }) };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dispatchAgentCommand } = require('../agent/dispatcher');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRuntime } = require('../agent/runtime');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pendingRegistry = require('../agent/pendingRegistry');

const INSTANCE = 'gateinst';

interface RuntimeOptions {
	gates?: Record<string, any> | null;
	capabilities?: Record<string, any>;
	reviewWrites?: boolean;
	staged?: any[];
}

/** Wire a host runtime that reports one instance's helper-published gates. */
function useRuntime(options: RuntimeOptions = {}) {
	const staged = options.staged || [];
	setRuntime({
		sendToBrowser: (payload: any) => { harness.sent.push(payload); },
		hasBrowserClient: () => true,
		isServerRunning: () => true,
		log: () => { /* quiet */ },
		reviewWritesEnabled: () => options.reviewWrites === true,
		stageAgentWrite: (input: any) => {
			staged.push(input);
			return { staged: true, reviewId: 'rev_test', message: 'held' };
		},
		getHelperBuildInfo: () => ({
			capabilities: options.capabilities ?? { instanceSecurityGates: 1, commandReview: 1 },
		}),
		getInstanceGates: () => options.gates ?? null,
	});
	return staged;
}

const ALL_OFF = {
	backgroundScripts: 'off',
	deleteRecords: 'off',
	createArtifacts: 'off',
	browserDebugger: 'off',
	restRequest: 'off',
};

function request(command: string, params: any = {}) {
	return { id: 'gate_1', command, instance: INSTANCE, params, timestamp: Date.now() };
}

/**
 * Answer the browser round-trip a command is waiting on. The dispatcher builds
 * its context from the runtime, so replies go through the real pending registry
 * rather than the harness queue.
 */
async function respondTo(action: string, response: any, predicate: (m: any) => boolean = () => true) {
	for (let i = 0; i < 100 && !harness.sent.some((m) => m.action === action && predicate(m)); i++) {
		await new Promise((r) => setImmediate(r));
	}
	const msg = harness.sent.find((m) => m.action === action && predicate(m));
	assert.ok(msg, `expected the command to send a ${action} message`);
	pendingRegistry.resolve(msg.agentRequestId, response);
}

test.afterEach(() => { harness.sent.length = 0; });
test.after(() => harness.cleanup());

// ---------------------------------------------------------------------------
// Issue #158: updating an existing record was ungated — update_record carried
// an empty gate list and update_record_batch was absent from the policy switch
// altogether, so an instance that held create_record for approval let an agent
// overwrite fields on every record it already had.
// ---------------------------------------------------------------------------

test('update_record is refused on an instance that does not allow writes', async () => {
	useRuntime({ gates: { ...ALL_OFF } });

	const resp = await dispatchAgentCommand(request('update_record', {
		sys_id: 'abc', table: 'incident', field: 'short_description', content: 'x',
	}));

	assert.strictEqual(resp.status, 'error');
	assert.strictEqual(resp.code, 'E_DISABLED');
	assert.strictEqual(harness.sent.length, 0, 'nothing reached the instance');
});

test('update_record_batch is refused on an instance that does not allow writes', async () => {
	useRuntime({ gates: { ...ALL_OFF } });

	const resp = await dispatchAgentCommand(request('update_record_batch', {
		sys_id: 'abc', table: 'rm_story', fields: { story_points: '20', state: '1' },
	}));

	assert.strictEqual(resp.status, 'error');
	assert.strictEqual(resp.code, 'E_DISABLED');
	assert.strictEqual(harness.sent.length, 0, 'nothing reached the instance');
});

test('a helper that predates the updateRecords gate falls back to createArtifacts', async () => {
	// 'approve' on the older gate must hold the update for review, the same way
	// it already holds a create, rather than waving it through.
	useRuntime({ gates: { ...ALL_OFF, createArtifacts: 'approve' } });

	const resp = await dispatchAgentCommand(request('update_record_batch', {
		sys_id: 'abc', table: 'rm_story', fields: { story_points: '20' },
	}));

	assert.strictEqual(resp.code, 'E_REVIEW_PENDING');
	const review = harness.sent.find((m) => m.action === 'reviewRequest');
	assert.ok(review, 'a review was raised');
	assert.ok(!harness.sent.some((m) => m.tableName === 'rm_story'), 'no write was sent');

	// A pending review holds a promise open for five minutes; settle it so the
	// test process can exit.
	pendingRegistry.reject(review.agentRequestId, 'E_USER_REJECTED', 'test teardown');
	await new Promise((r) => setImmediate(r));
});

test('an explicit updateRecords grant wins over the createArtifacts fallback', async () => {
	useRuntime({ gates: { ...ALL_OFF, createArtifacts: 'approve', updateRecords: 'auto' } });

	const resp = await dispatchAgentCommand(request('update_record', {
		sys_id: 'abc', table: 'incident', field: 'short_description', content: 'x',
	}));

	assert.strictEqual(resp.status, 'success');
	assert.ok(harness.sent.some((m) => m.tableName === 'incident'), 'the write went out');
});

test('an explicit updateRecords refusal wins over an open createArtifacts gate', async () => {
	useRuntime({ gates: { ...ALL_OFF, createArtifacts: 'auto', updateRecords: 'off' } });

	const resp = await dispatchAgentCommand(request('update_record', {
		sys_id: 'abc', table: 'incident', field: 'short_description', content: 'x',
	}));

	assert.strictEqual(resp.code, 'E_DISABLED');
	assert.strictEqual(harness.sent.length, 0);
});

test('a legacy helper (no per-instance gates) still updates by default', async () => {
	useRuntime({ gates: null, capabilities: {} });

	const resp = await dispatchAgentCommand(request('update_record', {
		sys_id: 'abc', table: 'incident', field: 'short_description', content: 'x',
	}));

	assert.strictEqual(resp.status, 'success');
});

// ---------------------------------------------------------------------------
// __review_bypass is the host's own marker for replaying a write the user has
// already approved. Arriving from a transport it is an agent opting itself out
// of review mode, so the dispatcher drops it.
// ---------------------------------------------------------------------------

test('__review_bypass from a caller is stripped, so review mode still holds the write', async () => {
	const staged = useRuntime({ gates: { ...ALL_OFF, createArtifacts: 'auto' }, reviewWrites: true });

	const resp = await dispatchAgentCommand(request('update_record', {
		sys_id: 'abc', table: 'incident', field: 'short_description', content: 'x',
		__review_bypass: true,
	}));

	assert.strictEqual(resp.status, 'success');
	assert.strictEqual(resp.result.staged, true, 'the write was parked for review');
	assert.strictEqual(staged.length, 1);
	assert.strictEqual(harness.sent.length, 0, 'nothing reached the instance');
});

test('the host may still replay its own approved write', async () => {
	const staged = useRuntime({ gates: { ...ALL_OFF, createArtifacts: 'auto' }, reviewWrites: true });

	const resp = await dispatchAgentCommand(request('update_record', {
		sys_id: 'abc', table: 'incident', field: 'short_description', content: 'x',
		__review_bypass: true,
	}), { internal: true });

	assert.strictEqual(resp.status, 'success');
	assert.strictEqual(staged.length, 0, 'an approved write is not re-staged');
	assert.ok(harness.sent.some((m) => m.tableName === 'incident'), 'the write went out');
});

// ---------------------------------------------------------------------------
// The same shape of gap, one command over: an attachment upload inserts a
// sys_attachment row, and the g_form bridge commits an open form — both wrote
// to a locked-down instance because neither carried a gate.
// ---------------------------------------------------------------------------

test('upload_attachment is refused when the instance does not allow creates', async () => {
	useRuntime({ gates: { ...ALL_OFF } });

	const resp = await dispatchAgentCommand(request('upload_attachment', {
		table: 'incident', sys_id: 'abc', fileName: 'note.txt', imageData: 'aGk=',
	}));

	assert.strictEqual(resp.code, 'E_DISABLED');
	assert.strictEqual(harness.sent.length, 0, 'nothing reached the instance');
});

test('upload_attachment rides the createArtifacts grant', async () => {
	useRuntime({ gates: { ...ALL_OFF, createArtifacts: 'auto' } });

	const pending = dispatchAgentCommand(request('upload_attachment', {
		table: 'incident', sys_id: '0123456789abcdef0123456789abcdef', fileName: 'note.txt', imageData: 'aGk=',
	}));
	await respondTo('uploadAttachment', { success: true, fileName: 'note.txt', attachment: { sys_id: 'att1' } });

	const resp = await pending;
	assert.strictEqual(resp.status, 'success');
	assert.strictEqual(resp.result.uploaded, true);
});

test('run_ui_action cannot commit a form on an instance that refuses updates', async () => {
	// navigate -> set_field -> run_ui_action('sysverb_update') was a complete
	// write path with no gate on it at all.
	useRuntime({ gates: { ...ALL_OFF, createArtifacts: 'off' } });

	const resp = await dispatchAgentCommand(request('run_ui_action', { uiAction: 'sysverb_update' }));

	assert.strictEqual(resp.code, 'E_DISABLED');
	assert.strictEqual(harness.sent.length, 0, 'the form was never saved');
});

test('run_ui_action is allowed by an explicit updateRecords grant', async () => {
	useRuntime({ gates: { ...ALL_OFF, updateRecords: 'auto' } });

	const pending = dispatchAgentCommand(request('run_ui_action', { uiAction: 'sysverb_update' }));
	await respondTo('agentRunUiAction', { success: true, uiAction: 'sysverb_update' });

	const resp = await pending;
	assert.strictEqual(resp.status, 'success');
	assert.strictEqual(resp.result.triggered, true);
});

test('a delete UI verb still escalates to deleteRecords, not updateRecords', async () => {
	// updateRecords must not become a way to reach the delete verbs.
	useRuntime({ gates: { ...ALL_OFF, updateRecords: 'auto' } });

	const resp = await dispatchAgentCommand(request('run_ui_action', { uiAction: 'sysverb_delete' }));

	assert.strictEqual(resp.code, 'E_DISABLED');
	assert.match(resp.error, /Delete Records/);
});

// ---------------------------------------------------------------------------
// Issue #162: sdk_deploy is confirmed in the helper's own install modal, so an
// 'approve' gate must not add a command review card in front of it. The gate
// still has to be granted.
// ---------------------------------------------------------------------------

test('sdk_deploy under an approve gate skips the command review', async () => {
	useRuntime({ gates: { ...ALL_OFF, createArtifacts: 'approve' } });

	const resp = await dispatchAgentCommand(request('sdk_deploy'));

	assert.notStrictEqual(resp.code, 'E_REVIEW_PENDING');
	assert.notStrictEqual(resp.code, 'E_DISABLED');
	assert.ok(!harness.sent.some((m) => m.action === 'reviewRequest'), 'no review card was sent');
});

test('sdk_deploy is still refused when the instance does not allow creates', async () => {
	useRuntime({ gates: { ...ALL_OFF } });

	const resp = await dispatchAgentCommand(request('sdk_deploy'));

	assert.strictEqual(resp.code, 'E_DISABLED');
	assert.strictEqual(harness.sent.length, 0, 'nothing reached the instance');
});

// ---------------------------------------------------------------------------
// A Batch API call (POST /api/now/v1/batch) carries its own requests, DELETE
// included. The policy saw one POST, so the deletes inside it met neither the
// deleteRecords gate nor the Review Queue.
// ---------------------------------------------------------------------------

const BATCH_DELETE = {
	endpoint: '/api/now/v1/batch',
	method: 'POST',
	body: { batch_request_id: 'b1', rest_requests: [
		{ id: '1', method: 'DELETE', url: '/api/now/table/incident/abc', headers: [] },
		{ id: '2', method: 'GET', url: '/api/now/table/incident?sysparm_limit=1', headers: [] },
	] },
};

test('a batch with DELETE sub-requests is refused when the instance does not allow deletes', async () => {
	useRuntime({ gates: { ...ALL_OFF, restRequest: 'auto' } });

	const resp = await dispatchAgentCommand(request('rest_request', BATCH_DELETE));

	assert.strictEqual(resp.code, 'E_DISABLED');
	assert.strictEqual(harness.sent.length, 0, 'nothing reached the instance');
});

test('a batch with DELETE sub-requests is held for review even when REST writes are automatic', async () => {
	useRuntime({ gates: { ...ALL_OFF, restRequest: 'auto', deleteRecords: 'approve' } });

	const resp = await dispatchAgentCommand(request('rest_request', BATCH_DELETE));

	assert.strictEqual(resp.code, 'E_REVIEW_PENDING');
	const review = harness.sent.find((m) => m.action === 'reviewRequest');
	assert.ok(review, 'a review was raised');
	assert.strictEqual(review.reviewKind, 'rest_batch');
	assert.strictEqual(review.risk, 'delete');
	assert.ok(!harness.sent.some((m) => m.action === 'agentRestApi'), 'the batch was not sent');

	pendingRegistry.reject(review.agentRequestId, 'E_USER_REJECTED', 'test teardown');
	await new Promise((r) => setImmediate(r));
});

test('a batch of plain writes still only needs the REST write permission', async () => {
	useRuntime({ gates: { ...ALL_OFF, restRequest: 'auto' } });
	const params = { ...BATCH_DELETE, body: { rest_requests: [
		{ id: '1', method: 'PATCH', url: '/api/now/table/incident/abc', body: 'e30=' },
	] } };

	const pending = dispatchAgentCommand(request('rest_request', params));
	await respondTo('agentRestApi', { success: true, status: 200, data: { serviced_requests: [] } });
	const resp = await pending;

	assert.strictEqual(resp.status, 'success');
	assert.ok(!harness.sent.some((m) => m.action === 'reviewRequest'), 'no review for a write');
});

// Regression: the helper used to execute a reviewed dry run as a real delete.
test('a delete_record dry run reads the record without a review', async () => {
	useRuntime({ gates: { ...ALL_OFF, deleteRecords: 'approve' } });

	const pending = dispatchAgentCommand(request('delete_record', { table: 'incident', sys_id: 'abc', dryRun: true }));
	await respondTo('agentRestApi', { success: true, status: 200, data: { result: { sys_id: 'abc', number: 'INC0001' } } });
	const resp = await pending;

	assert.strictEqual(resp.status, 'success');
	assert.deepStrictEqual(resp.result, { dryRun: true, deleted: false, table: 'incident', sys_id: 'abc', display: 'INC0001', message: 'Dry run: record not deleted' });
	assert.ok(!harness.sent.some((m) => m.action === 'reviewRequest'), 'no review for a dry run');
	assert.ok(!harness.sent.some((m) => m.method === 'DELETE'), 'nothing was deleted');
});

const EQUIVALENT_BATCH_ENDPOINTS = [
	'/api/now/v1/./batch', '/api/now/v1/x/../batch', '/api/now/v1/%2e/batch',
	'/api/now/v1/x/%2e%2e/batch', '/api/now/v1/batch#ignored',
];

for (const endpoint of EQUIVALENT_BATCH_ENDPOINTS) {
	test(`normalized batch target obeys delete permission and review: ${endpoint}`, async () => {
		const params = { ...BATCH_DELETE, endpoint };
		useRuntime({ gates: { ...ALL_OFF, restRequest: 'auto' } });
		const denied = await dispatchAgentCommand(request('rest_request', params));
		assert.strictEqual(denied.code, 'E_DISABLED');
		assert.strictEqual(harness.sent.length, 0);
		useRuntime({ gates: { ...ALL_OFF, restRequest: 'auto', deleteRecords: 'approve' } });
		const held = await dispatchAgentCommand(request('rest_request', params));
		assert.strictEqual(held.code, 'E_REVIEW_PENDING');
		const review = harness.sent.find(m => m.action === 'reviewRequest');
		assert.strictEqual(review?.reviewKind, 'rest_batch');
		assert.ok(!harness.sent.some(m => m.action === 'agentRestApi'));
		pendingRegistry.reject(review!.agentRequestId, 'E_USER_REJECTED', 'test teardown');
		await new Promise(r => setImmediate(r));
	});
}

test('approved single delete reads its target and returns the full deletion outcome', async () => {
	useRuntime({ gates: { ...ALL_OFF, deleteRecords: 'approve' } });
	const pending = dispatchAgentCommand(request('delete_record', { table: 'incident', sys_id: 'abc', awaitReview: true }));
	await respondTo('reviewRequest', { success: true, approvedNotExecuted: true });
	await respondTo('agentRestApi', { success: true, status: 200, data: { result: { sys_id: 'abc', number: 'INC0001' } } }, m => m.method === 'GET');
	await respondTo('agentRestApi', { success: true, status: 204, data: null }, m => m.method === 'DELETE');
	const result = await pending;
	assert.strictEqual(result.status, 'success');
	assert.deepStrictEqual(result.result, { deleted: true, table: 'incident', sys_id: 'abc', display: 'INC0001' });
	assert.deepStrictEqual(harness.sent.filter(m => m.action === 'agentRestApi').map(m => m.method), ['GET', 'DELETE']);
	assert.strictEqual(harness.sent.filter(m => m.action === 'reviewRequest').length, 1);
});
