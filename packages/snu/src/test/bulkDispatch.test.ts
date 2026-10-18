import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { PendingRegistry } from '../server/pendingRegistry.js';

// create_records / update_records on the standalone host: validated and given
// a batch id before review, one review per batch, caller plans stripped.

const A = '0123456789abcdef0123456789abcdef';

function setup(gate: 'auto' | 'approve', capabilities: Record<string, any> = { instanceSecurityGates: 1, commandReview: 1, recordBatch: 1 }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-bulk-'));
  fs.mkdirSync(path.join(cwd, 'bulkinst'));
  fs.writeFileSync(path.join(cwd, 'bulkinst', '_settings.json'), JSON.stringify({ url: 'https://bulkinst.service-now.com', g_ck: 'tok' }));
  const pending = new PendingRegistry();
  const bridge = new StandaloneWsBridge(0, pending);
  const sent: any[] = [];
  (bridge as any).hasBrowserClient = () => true;
  (bridge as any).getLiveInstances = () => [];
  (bridge as any).getHelperState = () => ({ tier: 'pro', proFeatures: true, cdp: { available: false }, capabilities });
  (bridge as any).getInstanceGate = () => gate;
  (bridge as any).registerReview = () => { /* review bookkeeping not under test */ };
  (bridge as any).cancelReview = () => { /* nothing to cancel */ };
  (bridge as any).sendToBrowser = (message: any) => {
    sent.push(message);
    // The table probe a batch makes while preparing.
    if (message.action === 'agentRestApi' && message.method === 'GET') {
      if (message.endpoint === '/api/now/ui/meta/sys_choice') pending.resolve(message.agentRequestId, { success: true, status: 200, data: { result: { columns: { inactive: { internal_type: 'boolean' } } } } });
      else if (message.endpoint === '/api/now/table/no_such_table') pending.reject(message.agentRequestId, 'E_INVALID_PARAMS', 'Invalid table no_such_table', { status: 400 });
      else pending.resolve(message.agentRequestId, { success: true, status: 200, data: { result: [] } });
    }
  };
  const dispatcher = new StandaloneDispatcher({ cwd, wsBridge: bridge, pending, cliFlags: { updateRecords: true, createArtifacts: true } });
  return { dispatcher, sent, pending, cleanup: () => { pending.rejectAll('E_CANCELLED', 'test finished'); fs.rmSync(cwd, { recursive: true, force: true }); } };
}

const req = (command: string, params: any) => ({ id: `${command}_1`, command, params, instance: 'bulkinst' });

test('standalone: invalid rows are refused before review', async () => {
  const s = setup('approve');
  try {
    const resp = await s.dispatcher.dispatch(req('update_records', { table: 'incident', rows: [{ urgency: '2' }] }));
    assert.strictEqual(resp.code, 'E_INVALID_PARAMS');
    assert.ok(!s.sent.some(m => m.action === 'agentRecordBatch' || m.action === 'reviewRequest'));
  } finally { s.cleanup(); }
});

test('standalone: an approve gate raises one review with the validated batch, never the caller\'s plan', async () => {
  const s = setup('approve');
  try {
    const resp = await s.dispatcher.dispatch(req('update_records', {
      table: 'incident', rows: [{ sys_id: A, urgency: '2' }],
      __batch: { batchId: 'bat_x_000000', mode: 'update', table: 'sys_user', rows: [{ index: 0, sys_id: A, fields: { roles: 'admin' } }] },
    }));
    assert.strictEqual(resp.code, 'E_REVIEW_PENDING');
    const review = s.sent.find(m => m.action === 'reviewRequest');
    assert.ok(review);
    assert.strictEqual(review.reviewKind, 'record_batch');
    assert.strictEqual(review.params.__batch.table, 'incident');
    assert.notStrictEqual(review.params.__batch.batchId, 'bat_x_000000');
    assert.strictEqual(resp.details!.batchId, review.params.__batch.batchId);
    assert.ok(!s.sent.some(m => m.action === 'agentRecordBatch'));
  } finally { s.cleanup(); }
});

test('standalone: dryRun behind an approve gate validates without a review or a write', async () => {
  const s = setup('approve');
  try {
    const resp = await s.dispatcher.dispatch(req('create_records', { table: 'sys_choice', dryRun: true, rows: [{ label: 'a' }] }));
    assert.strictEqual(resp.status, 'success', resp.error);
    assert.strictEqual(resp.result.dryRun, true);
    assert.ok(!s.sent.some(m => m.action === 'agentRecordBatch' || m.action === 'reviewRequest'));
  } finally { s.cleanup(); }
});

test('standalone: an older helper is refused instead of sent rows', async () => {
  const s = setup('auto', { instanceSecurityGates: 1, commandReview: 1 });
  try {
    const resp = await s.dispatcher.dispatch(req('create_records', { table: 'sys_choice', rows: [{ label: 'a' }] }));
    assert.strictEqual(resp.code, 'E_UNSUPPORTED_HOST');
    assert.ok(!s.sent.some(m => m.action === 'agentRecordBatch' || m.action === 'reviewRequest'));
  } finally { s.cleanup(); }
});

test('standalone: a refused batch keeps its id and every row in the error details', async () => {
  const s = setup('auto');
  try {
    const pendingResp = s.dispatcher.dispatch(req('create_records', { table: 'sys_choice', rows: [{ label: 'a' }, { label: 'b' }] }));
    for (let i = 0; i < 100 && !s.sent.some(m => m.action === 'agentRecordBatch'); i++) await new Promise(r => setImmediate(r));
    const msg = s.sent.find(m => m.action === 'agentRecordBatch');
    assert.strictEqual(msg.action, 'agentRecordBatch');
    s.pending.resolve(msg.agentRequestId, { success: true, batch: { batchId: msg.batchId, mode: 'create', table: 'sys_choice', total: 2, running: false,
      rows: [{ index: 0, outcome: 'failed', status: 400, error: 'bad' }, { index: 1, outcome: 'not_attempted' }] } });
    const resp = await pendingResp;
    assert.strictEqual(resp.code, 'E_COMMAND_FAILED');
    assert.strictEqual(resp.details!.batchId, msg.batchId);
    assert.deepStrictEqual(resp.details!.rows.map((r: any) => r.outcome), ['failed', 'not_attempted']);
  } finally { s.cleanup(); }
});

test('standalone: a table that does not exist is refused', async () => {
  const s = setup('auto');
  try {
    const resp = await s.dispatcher.dispatch(req('create_records', { table: 'no_such_table', dryRun: true, rows: [{ a: 1 }] }));
    assert.strictEqual(resp.code, 'E_INVALID_PARAMS');
    assert.match(resp.error || '', /does not exist/);
  } finally { s.cleanup(); }
});

test('standalone: a lost answer keeps the batchId; a refusal before any row stays a refusal', async () => {
  const s = setup('auto');
  try {
    const wait = async () => { for (let i = 0; i < 100 && !s.sent.some(m => m.action === 'agentRecordBatch'); i++) await new Promise(r => setImmediate(r)); return s.sent.find(m => m.action === 'agentRecordBatch'); };
    let pendingResp = s.dispatcher.dispatch(req('create_records', { table: 'sys_choice', rows: [{ label: 'a' }] }));
    let msg = await wait();
    s.pending.reject(msg.agentRequestId, 'E_BROWSER_DISCONNECTED', 'Browser helper disconnected');
    let resp = await pendingResp;
    assert.strictEqual(resp.code, 'E_TIMEOUT');
    assert.strictEqual(resp.details!.batchId, msg.batchId);
    assert.strictEqual(resp.details!.retrySafe, false);
    s.sent.length = 0;

    pendingResp = s.dispatcher.dispatch(req('create_records', { table: 'sys_choice', rows: [{ label: 'a' }] }));
    msg = await wait();
    s.pending.reject(msg.agentRequestId, 'E_COMMAND_FAILED', 'could not record batch progress', { notStarted: true });
    resp = await pendingResp;
    assert.strictEqual(resp.code, 'E_COMMAND_FAILED');
    assert.match(resp.error || '', /record batch progress/);
  } finally { s.cleanup(); }
});

test('standalone: compare rules reach the helper and field warnings reach the caller', async () => {
  const s = setup('auto');
  try {
    const pendingResp = s.dispatcher.dispatch(req('create_records', { table: 'sys_choice', rows: [{ label: 'a', inactive: 'false' }] }));
    for (let i = 0; i < 100 && !s.sent.some(m => m.action === 'agentRecordBatch'); i++) await new Promise(r => setImmediate(r));
    const msg = s.sent.find(m => m.action === 'agentRecordBatch');
    assert.deepStrictEqual(msg.fieldKinds, { inactive: 'bool' });
    s.pending.resolve(msg.agentRequestId, { success: true, batch: { batchId: msg.batchId, mode: 'create', table: 'sys_choice', total: 1, running: false,
      rows: [{ index: 0, outcome: 'succeeded', status: 201, sys_id: A, warnings: [{ field: 'label', issue: 'different' }] }] } });
    const resp = await pendingResp;
    assert.strictEqual(resp.status, 'success');
    assert.deepStrictEqual(resp.result.rows[0].warnings, [{ field: 'label', issue: 'different' }]);
  } finally { s.cleanup(); }
});
