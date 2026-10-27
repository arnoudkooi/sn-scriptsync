import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { PendingRegistry } from '../server/pendingRegistry.js';

// Reported by email (October 2026): POST /api/now/v1/batch carried DELETE
// sub-requests past the Delete records gate and the Review Queue, because the
// policy classified rest_request by the outer method alone. Mirrors the
// helper harness in parity.test.ts.

const sysId = '0123456789abcdef0123456789abcdef';
const origin = 'https://testinst.service-now.com';

async function waitFor<T>(fn: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const result = fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error('Helper message did not arrive');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function helper(t: any, cliFlags: Record<string, any>, gates: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-rest-batch-'));
  fs.mkdirSync(path.join(root, 'testinst'));
  const pending = new PendingRegistry();
  const bridge = new StandaloneWsBridge(0, pending);
  const port = await bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: any[] = [];
  ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  await new Promise<void>(resolve => ws.once('open', resolve));
  const dispatcher = new StandaloneDispatcher({ cwd: root, wsBridge: bridge, pending,
    cliFlags: { backgroundScripts: true, createArtifacts: true, updateRecords: true, ...cliFlags } });
  const send = (message: any) => ws.send(JSON.stringify(message));
  const allGates: Record<string, string> = { backgroundScripts: 'off', createArtifacts: 'off', updateRecords: 'off', browserDebugger: 'off', ...gates };
  send({ instance: { name: 'testinst', url: origin, g_ck: 'test-token' } });
  send({ action: 'helperBuildInfo', extensionName: 'SN Utils', extensionVersion: '10.2.9.0',
    capabilities: { protocolVersion: 1, commandReview: 1, instanceSecurityGates: 1 } });
  send({ action: 'helperGatesUpdated', instanceOrigin: origin, revision: 1, gates: allGates });
  await waitFor(() => bridge.getHelperState().capabilities?.instanceSecurityGates === 1
    && bridge.getLiveInstances().some(instance => instance.name === 'testinst')
    && bridge.getHelperState().instanceGates.has(origin)
    && bridge.getInstanceGate(origin, 'restRequest') === allGates.restRequest ? true : undefined);
  t.after(async () => { ws.close(); await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const message = (action: string) => waitFor(() => messages.find(m => m.action === action));
  const poll = (reviewId: string, waitSeconds = 0) => dispatcher.dispatch({ id: 'poll_' + Math.random(), command: 'get_review_result', params: { reviewId, waitSeconds } });
  const approve = (review: any) => send({ action: 'reviewResponse', approved: true,
    reviewId: review.reviewId, nonce: review.nonce, payloadHash: review.payloadHash });
  return { dispatcher, messages, send, message, poll, approve };
}

const batchDelete = {
  endpoint: '/api/now/v1/batch',
  method: 'POST',
  body: { batch_request_id: 'cleanup', rest_requests: [
    { id: '1', method: 'DELETE', url: `/api/now/table/incident/${sysId}`, headers: [] },
    { id: '2', method: 'DELETE', url: `/api/now/table/incident/${sysId.replace(/0/g, '1')}`, headers: [] },
    { id: '3', method: 'GET', url: '/api/now/table/incident?sysparm_limit=1', headers: [] },
  ] },
};

test('a batch with DELETE sub-requests needs the host delete permission', async t => {
  const h = await helper(t, { restRequest: true, deleteRecords: false }, { deleteRecords: 'auto', restRequest: 'auto' });
  const response = await h.dispatcher.dispatch({ id: 'batch-host', command: 'rest_request', params: batchDelete });
  assert.equal(response.code, 'E_DISABLED');
  assert.equal(response.details?.gate, 'deleteRecords');
  assert.equal(response.details?.source, 'host');
  assert.ok(!h.messages.some(m => m.action === 'agentRestApi'), 'nothing reached the instance');
});

test('a batch with DELETE sub-requests needs the instance delete permission', async t => {
  const h = await helper(t, { restRequest: true, deleteRecords: true }, { deleteRecords: 'off', restRequest: 'auto' });
  const response = await h.dispatcher.dispatch({ id: 'batch-instance', command: 'rest_request', params: batchDelete });
  assert.equal(response.code, 'E_DISABLED');
  assert.equal(response.details?.gate, 'deleteRecords');
  assert.equal(response.details?.source, 'instance');
  assert.ok(!h.messages.some(m => m.action === 'agentRestApi'), 'nothing reached the instance');
});

test('a batch with DELETE sub-requests waits for review even when plain REST writes are automatic', async t => {
  // Delete records: approve, REST request: auto. The review used to depend on
  // the order the gates were checked in, with the last one winning.
  const h = await helper(t, { restRequest: true, deleteRecords: true }, { deleteRecords: 'approve', restRequest: 'auto' });
  const initial = await h.dispatcher.dispatch({ id: 'batch-review', command: 'rest_request', params: batchDelete });
  assert.equal(initial.code, 'E_REVIEW_PENDING', initial.error);
  assert.ok(!h.messages.some(m => m.action === 'agentRestApi'), 'nothing runs before approval');
  const review = await h.message('reviewRequest');
  assert.equal(review.command, 'rest_request');
  assert.equal(review.reviewKind, 'rest_batch');
  assert.equal(review.risk, 'delete');
  assert.deepEqual(review.params, batchDelete);
  h.approve(review);
  // The helper cannot run this shape itself and hands execution back.
  const execute = await h.message('executeApproved');
  h.send({ agentRequestId: execute.agentRequestId, success: true, approvedNotExecuted: true });
  const post = await h.message('agentRestApi');
  assert.equal(post.method, 'POST');
  assert.equal(post.endpoint, '/api/now/v1/batch');
  assert.deepEqual(post.body, batchDelete.body);
  h.send({ agentRequestId: post.agentRequestId, success: true, status: 200, data: { batch_request_id: 'cleanup', serviced_requests: [] } });
  const response = await h.poll(review.reviewId, 1);
  assert.equal(response.status, 'success', response.error);
  assert.equal(response.result.status, 200);
  assert.deepEqual(response.result.data, { batch_request_id: 'cleanup', serviced_requests: [] });
  assert.equal(h.messages.filter(m => m.action === 'agentRestApi').length, 1, 'the batch ran once');
});

test('a batch of plain writes stays a REST write with no review', async t => {
  const h = await helper(t, { restRequest: true, deleteRecords: false }, { deleteRecords: 'off', restRequest: 'auto' });
  const params = { ...batchDelete, body: { rest_requests: [
    { id: '1', method: 'PATCH', url: `/api/now/table/incident/${sysId}`, body: 'eyJzdGF0ZSI6IjYifQ==' },
    { id: '2', method: 'GET', url: '/api/now/table/incident?sysparm_limit=1' },
  ] } };
  const pending = h.dispatcher.dispatch({ id: 'batch-write', command: 'rest_request', params });
  const post = await h.message('agentRestApi');
  h.send({ agentRequestId: post.agentRequestId, success: true, status: 200, data: { serviced_requests: [] } });
  const response = await pending;
  assert.equal(response.status, 'success', response.error);
  assert.ok(!h.messages.some(m => m.action === 'reviewRequest'), 'no review for a write');
});

for (const endpoint of [
  '/api/now/v1/./batch', '/api/now/v1/x/../batch', '/api/now/v1/%2e/batch',
  '/api/now/v1/x/%2e%2e/batch', '/api/now/v1/batch#ignored',
]) {
  test(`normalized batch target obeys host and instance delete permission: ${endpoint}`, async t => {
    const params = { ...batchDelete, endpoint };
    const host = await helper(t, { restRequest: true, deleteRecords: false }, { restRequest: 'auto', deleteRecords: 'auto' });
    const denied = await host.dispatcher.dispatch({ id: 'host', command: 'rest_request', params });
    assert.equal(denied.code, 'E_DISABLED');
    assert.equal(denied.details?.source, 'host');
    const instance = await helper(t, { restRequest: true, deleteRecords: true }, { restRequest: 'auto', deleteRecords: 'off' });
    const refused = await instance.dispatcher.dispatch({ id: 'instance', command: 'rest_request', params });
    assert.equal(refused.code, 'E_DISABLED');
    assert.equal(refused.details?.source, 'instance');
    assert.ok(![...host.messages, ...instance.messages].some(m => m.action === 'agentRestApi'));
  });
  test(`normalized batch target waits for deletion approval: ${endpoint}`, async t => {
    const h = await helper(t, { restRequest: true, deleteRecords: true }, { restRequest: 'auto', deleteRecords: 'approve' });
    const response = await h.dispatcher.dispatch({ id: 'held', command: 'rest_request', params: { ...batchDelete, endpoint } });
    assert.equal(response.code, 'E_REVIEW_PENDING');
    const review = await h.message('reviewRequest');
    assert.equal(review.reviewKind, 'rest_batch');
    assert.ok(!h.messages.some(m => m.action === 'agentRestApi'));
    h.send({ action: 'reviewResponse', approved: false, reviewId: review.reviewId, nonce: review.nonce, payloadHash: review.payloadHash });
    assert.equal((await h.poll(review.reviewId, 1)).code, 'E_USER_REJECTED');
  });
}

test('approved single deletion returns the same readback and outcome as an automatic deletion', async t => {
  const h = await helper(t, { deleteRecords: true }, { deleteRecords: 'approve', restRequest: 'off' });
  const initial = await h.dispatcher.dispatch({ id: 'single', command: 'delete_record', params: { table: 'incident', sys_id: sysId } });
  assert.equal(initial.code, 'E_REVIEW_PENDING');
  const review = await h.message('reviewRequest');
  assert.ok(!h.messages.some(m => m.action === 'agentRestApi'));
  h.approve(review);
  const execute = await h.message('executeApproved');
  h.send({ agentRequestId: execute.agentRequestId, success: true, approvedNotExecuted: true });
  const read = await waitFor(() => h.messages.find(m => m.action === 'agentRestApi' && m.method === 'GET'));
  assert.equal(read.endpoint, `/api/now/table/incident/${sysId}`);
  h.send({ agentRequestId: read.agentRequestId, success: true, status: 200, data: { result: { sys_id: sysId, number: 'INC0001' } } });
  const del = await waitFor(() => h.messages.find(m => m.action === 'agentRestApi' && m.method === 'DELETE'));
  h.send({ agentRequestId: del.agentRequestId, success: true, status: 204, data: null });
  const result = await h.poll(review.reviewId, 1);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.result, { reviewId: review.reviewId, command: 'delete_record', deleted: true, table: 'incident', sys_id: sysId, display: 'INC0001' });
  assert.deepEqual(h.messages.filter(m => m.action === 'agentRestApi').map(m => m.method), ['GET', 'DELETE']);
});
