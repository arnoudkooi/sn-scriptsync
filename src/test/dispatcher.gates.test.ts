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
async function respondTo(action: string, response: any) {
	for (let i = 0; i < 100 && !harness.sent.some((m) => m.action === action); i++) {
		await new Promise((r) => setImmediate(r));
	}
	const msg = harness.sent.find((m) => m.action === action);
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
		table: 'incident', sys_id: 'abc', fileName: 'note.txt', imageData: 'aGk=',
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
