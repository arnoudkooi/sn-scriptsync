import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { StandaloneHttpBridge } from '../server/httpBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { ReviewRegistry } from '../server/reviewRegistry.js';
import { STANDALONE_COMMANDS } from '../server/commands.js';
import { AGENT_API_VERSION } from '../types.js';
import { VERSION } from '../version.js';
import { getToolByName, TOOLS } from '../registry.js';
import { resolveAttachment } from '../server/attachmentInput.js';

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

async function helper(t: any, options: Record<string, any> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-parity-'));
  fs.mkdirSync(path.join(root, 'testinst'));
  const pending = new PendingRegistry();
  const bridge = new StandaloneWsBridge(0, pending);
  const port = await bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: any[] = [];
  ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  await new Promise<void>(resolve => ws.once('open', resolve));
  const dispatcher = new StandaloneDispatcher({ cwd: root, wsBridge: bridge, pending,
    cliFlags: { backgroundScripts: true, createArtifacts: true, updateRecords: true, ...options } });
  const send = (message: any) => ws.send(JSON.stringify(message));
  const gates = { backgroundScripts: 'approve', createArtifacts: 'auto', updateRecords: 'auto',
    deleteRecords: 'off', restRequest: 'off', browserDebugger: 'off' };
  send({ instance: { name: 'testinst', url: origin, g_ck: 'test-token' } });
  send({ action: 'helperBuildInfo', extensionName: 'SN Utils', extensionVersion: '10.2.6.0',
    capabilities: { protocolVersion: 1, commandReview: 1, instanceSecurityGates: 1 } });
  send({ action: 'helperGatesUpdated', instanceOrigin: origin, revision: 1, gates });
  await waitFor(() => bridge.getInstanceGate(origin, 'updateRecords') === 'auto' ? true : undefined);
  t.after(async () => { ws.close(); await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const message = (action: string) => waitFor(() => messages.find(m => m.action === action));
  const poll = (reviewId: string, waitSeconds = 0) => dispatcher.dispatch({ id: 'poll_' + Math.random(), command: 'get_review_result', params: { reviewId, waitSeconds } });
  const approve = (review: any, extra = {}) => send({ action: 'reviewResponse', approved: true,
    reviewId: review.reviewId, nonce: review.nonce, payloadHash: review.payloadHash, ...extra });
  return { root, ws, bridge, pending, dispatcher, messages, send, message, poll, approve, gates };
}

test('negotiation and health share a complete command list without a helper', async t => {
  const pending = new PendingRegistry();
  const bridge = new StandaloneWsBridge(0, pending);
  const dispatcher = new StandaloneDispatcher({ wsBridge: bridge, pending });
  const http = new StandaloneHttpBridge({ port: 0, token: 'test-agent', dispatcher });
  const port = await http.start();
  t.after(() => http.close());
  const health: any = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  const response = await dispatcher.dispatch({ id: 'neg', command: 'negotiate' });
  assert.deepEqual(health.commands, STANDALONE_COMMANDS);
  assert.deepEqual(response.result.commands, health.commands);
  assert.equal(response.result.helper, null);
  assert.equal(response.result.bridgeVersion, VERSION);
  assert.equal(health.transportApiVersion, AGENT_API_VERSION);
  for (const tool of TOOLS.filter(tool => tool.agentCommand !== 'get_context')) {
    assert.ok(health.commands.includes(tool.agentCommand), `${tool.name} must work on the standalone host`);
  }
  const unknown = await dispatcher.dispatch({ id: 'unknown', command: 'does_not_exist' });
  assert.equal(unknown.code, 'E_UNKNOWN_COMMAND');
});

test('negotiate reports the helper build but never its session token', async t => {
  const h = await helper(t);
  const result = await h.dispatcher.dispatch({ id: 'neg', command: 'negotiate' });
  assert.equal(result.result.helper.extensionVersion, '10.2.6.0');
  assert.equal(result.result.browserConnected, true);
  assert.ok(!JSON.stringify(result).includes('test-token'));
});

test('batch update sends one PATCH, strips sys_scope and reports silently dropped fields', async t => {
  const h = await helper(t);
  const result = h.dispatcher.dispatch({ id: 'batch', command: 'update_record_batch',
    params: { table: 'sp_widget', sys_id: sysId, fields: { script: 'gs.info(1);', css: 'a{}', sys_scope: 'global' }, await: true } });
  const request = await h.message('agentRestApi');
  assert.equal(request.endpoint, `/api/now/table/sp_widget/${sysId}`);
  assert.deepEqual(request.body, { script: 'gs.info(1);', css: 'a{}' });
  h.send({ agentRequestId: request.agentRequestId, success: true, data: { result: { script: '', css: 'a{}' } } });
  const response = await result;
  assert.equal(response.status, 'success');
  assert.deepEqual(response.result.persisted, { script: '', css: 'a{}' });
  assert.equal(response.result.warnings.length, 2);
  assert.equal(h.messages.filter(m => m.action === 'agentRestApi').length, 1);
});

test('batch and upload cannot bypass the host gates or the helper instance gates', async t => {
  const h = await helper(t, { updateRecords: false, createArtifacts: false });
  for (const command of ['update_record_batch', 'upload_attachment']) {
    const response = await h.dispatcher.dispatch({ id: command, command,
      params: { table: 'incident', sys_id: sysId, fields: { short_description: 'x' }, __review_bypass: true } });
    assert.equal(response.code, 'E_DISABLED');
  }
  const openHost = new StandaloneDispatcher({ cwd: h.root, wsBridge: h.bridge, pending: h.pending,
    cliFlags: { updateRecords: true, createArtifacts: true } });
  h.send({ action: 'helperGatesUpdated', instanceOrigin: origin, revision: 2,
    gates: { ...h.gates, updateRecords: 'off', createArtifacts: 'off' } });
  await waitFor(() => h.bridge.getInstanceGate(origin, 'updateRecords') === 'off' ? true : undefined);
  for (const command of ['update_record_batch', 'upload_attachment']) {
    assert.equal((await openHost.dispatch({ id: command, command, params: {} })).code, 'E_DISABLED');
  }
  assert.ok(!h.messages.some(m => m.action === 'agentRestApi' || m.action === 'uploadAttachment'));
});

test('attachment file uses the helper upload shape and preserves binary bytes', async t => {
  const h = await helper(t);
  const file = path.join(h.root, 'testinst/report.pdf');
  const bytes = Buffer.from([0, 255, 1, 10, 13]);
  fs.writeFileSync(file, bytes);
  const pending = h.dispatcher.dispatch({ id: 'upload', command: 'upload_attachment',
    params: { table: 'incident', sys_id: sysId, filePath: 'report.pdf' } });
  const request = await h.message('uploadAttachment');
  assert.equal(request.tableName, 'incident');
  assert.equal(request.recordSysId, sysId);
  assert.equal(request.contentType, 'application/pdf');
  assert.deepEqual(Buffer.from(request.imageData, 'base64'), bytes);
  h.send({ agentRequestId: request.agentRequestId, success: true, attachment: { sys_id: 'attachment-id' } });
  assert.equal((await pending).result.attachment.sys_id, 'attachment-id');
});

test('attachment inputs reject siblings, symlinks, conflicting sources and malformed base64', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-input-'));
  const outside = fs.mkdtempSync(root + '-sibling-');
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not-uploaded');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
  const params = { table: 'incident', sys_id: sysId };
  for (const filePath of [path.join(outside, 'secret.txt'), path.join(root, 'linked.txt')]) {
    assert.throws(() => resolveAttachment({ ...params, filePath }, root), (e: any) => e.code === 'E_SECURITY');
  }
  for (const extra of [{ filePath: 'x', imageData: 'eA==' }, { fileName: 'x', imageData: 'invalid!' }]) {
    assert.throws(() => resolveAttachment({ ...params, ...extra }, root), (e: any) => e.code === 'E_INVALID_PARAMS');
  }
});

test('nonblocking review moves from pending to running to a retained result with one execution', async t => {
  const h = await helper(t);
  const initial = await h.dispatcher.dispatch({ id: 'script', command: 'run_background_script', params: { script: 'gs.info(1);' } });
  assert.equal(initial.code, 'E_REVIEW_PENDING');
  const review = await h.message('reviewRequest');
  assert.equal(review.reviewId, initial.details!.reviewId);
  assert.equal((await h.poll(review.reviewId)).details?.running, undefined);
  h.approve(review);
  const execute = await h.message('executeApproved');
  assert.equal((await h.poll(review.reviewId)).details?.running, true);
  h.send({ agentRequestId: execute.agentRequestId, success: true, output: 'done' });
  const finished = await h.poll(review.reviewId, 1);
  assert.equal(finished.result.output, 'done');
  assert.equal((await h.poll(review.reviewId)).result.output, 'done');
  assert.equal(h.messages.filter(m => m.action === 'executeApproved').length, 1);
});

test('review delivery failure settles immediately without leaving a pending request', async t => {
  const h = await helper(t);
  const original = h.bridge.sendToBrowser.bind(h.bridge);
  h.bridge.sendToBrowser = message => {
    if (message.action === 'reviewRequest') throw Object.assign(new Error('Helper disconnected'), { code: 'E_BROWSER_DISCONNECTED' });
    original(message);
  };
  const response = await h.dispatcher.dispatch({ id: 'failed-send', command: 'run_background_script', params: { script: 'gs.info(1);' } });
  assert.equal(response.code, 'E_BROWSER_DISCONNECTED');
  assert.equal(h.pending.size(), 0);
});

test('pending HTTP reviews return 202 and execution failures remain available to poll', async t => {
  const h = await helper(t);
  const http = new StandaloneHttpBridge({ port: 0, token: 'test-agent', dispatcher: h.dispatcher });
  const port = await http.start();
  t.after(() => http.close());
  const response = await fetch(`http://127.0.0.1:${port}/api`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': 'test-agent' },
    body: JSON.stringify({ id: 'http-script', command: 'run_background_script', params: { script: 'gs.info(1);' } }) });
  assert.equal(response.status, 202);
  const initial: any = await response.json();
  const review = await h.message('reviewRequest');
  h.approve(review);
  const execute = await h.message('executeApproved');
  h.send({ agentRequestId: execute.agentRequestId, success: false, status: 403, error: 'ACL denied' });
  const failed = await h.poll(initial.details.reviewId, 1);
  assert.equal(failed.code, 'E_COMMAND_FAILED');
  assert.ok(failed.error?.includes('ACL denied'));
  assert.equal((await h.poll(initial.details.reviewId)).code, 'E_COMMAND_FAILED');
});

test('reviewed batch hands execution back to the host once and returns its full result', async t => {
  const h = await helper(t);
  h.send({ action: 'helperGatesUpdated', instanceOrigin: origin, revision: 2, gates: { ...h.gates, updateRecords: 'approve' } });
  await waitFor(() => h.bridge.getInstanceGate(origin, 'updateRecords') === 'approve' ? true : undefined);
  const initial = await h.dispatcher.dispatch({ id: 'batch', command: 'update_record_batch',
    params: { table: 'incident', sys_id: sysId, fields: { short_description: 'changed' }, __review_bypass: true } });
  assert.equal(initial.code, 'E_REVIEW_PENDING');
  assert.ok(!h.messages.some(m => m.action === 'agentRestApi'));
  const review = await h.message('reviewRequest');
  h.approve(review);
  const execute = await h.message('executeApproved');
  h.send({ agentRequestId: execute.agentRequestId, success: true, approvedNotExecuted: true });
  const patch = await h.message('agentRestApi');
  h.send({ agentRequestId: patch.agentRequestId, success: true, data: { result: patch.body } });
  const response = await h.poll(review.reviewId, 1);
  assert.deepEqual(response.result.persisted, { short_description: 'changed' });
  assert.equal(h.messages.filter(m => m.action === 'agentRestApi').length, 1);
});

test('host continuation rechecks a permission revoked during review', async t => {
  const h = await helper(t);
  h.send({ action: 'helperGatesUpdated', instanceOrigin: origin, revision: 2, gates: { ...h.gates, updateRecords: 'approve' } });
  await waitFor(() => h.bridge.getInstanceGate(origin, 'updateRecords') === 'approve' ? true : undefined);
  const initial = await h.dispatcher.dispatch({ id: 'revoke', command: 'update_record_batch',
    params: { table: 'incident', sys_id: sysId, fields: { short_description: 'changed' } } });
  const review = await h.message('reviewRequest');
  h.approve(review);
  const execute = await h.message('executeApproved');
  h.send({ action: 'helperGatesUpdated', instanceOrigin: origin, revision: 3, gates: { ...h.gates, updateRecords: 'off' } });
  await waitFor(() => h.bridge.getInstanceGate(origin, 'updateRecords') === 'off' ? true : undefined);
  h.send({ agentRequestId: execute.agentRequestId, success: true, approvedNotExecuted: true });
  assert.equal((await h.poll(initial.details!.reviewId!, 1)).code, 'E_DISABLED');
  assert.ok(!h.messages.some(m => m.action === 'agentRestApi'));
});

test('rejection and cancellation remain collectable, and late approval cannot execute', async t => {
  const h = await helper(t);
  const initial = await h.dispatcher.dispatch({ id: 'reject', command: 'run_background_script', params: { script: 'gs.info(1);' } });
  const review = await h.message('reviewRequest');
  h.approve(review, { approved: false, userFeedback: 'No' });
  assert.equal((await h.poll(initial.details!.reviewId!, 1)).code, 'E_USER_REJECTED');
  h.messages.length = 0;
  const second = await h.dispatcher.dispatch({ id: 'cancel', command: 'run_background_script', params: { script: 'gs.info(2);' } });
  const cancelled = await h.message('reviewRequest');
  h.dispatcher.cancel('cancel');
  assert.equal((await h.poll(second.details!.reviewId!, 1)).code, 'E_COMMAND_FAILED');
  h.approve(cancelled);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!h.messages.some(m => m.action === 'executeApproved'));
});

test('review result expiry starts after settlement and polling removes timed-out waiters', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reviews = new ReviewRegistry();
  reviews.register('long', 'update_record_batch');
  reviews.markRunning('long');
  t.mock.timers.tick(20 * 60_000);
  assert.equal(reviews.get('long')?.running, true);
  const waiting = reviews.wait('long', 100);
  t.mock.timers.tick(100);
  await waiting;
  assert.equal(reviews.get('long')?.waiters.size, 0);
  reviews.settle('long', { id: 'x', command: 'update_record_batch', status: 'success', timestamp: 0, result: {} });
  t.mock.timers.tick(9 * 60_000);
  assert.ok(reviews.get('long'));
  t.mock.timers.tick(2 * 60_000);
  assert.equal(reviews.get('long'), undefined);
});

test('field file adapters preserve newlines and reject arrays and ambiguous sources', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-fields-'));
  const originalCwd = process.cwd();
  t.after(() => { process.chdir(originalCwd); fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(root);
  const fields = { script: 'function f() {\n  return true;\n}' };
  fs.writeFileSync('fields.json', JSON.stringify(fields));
  for (const name of ['snu_create_artifact', 'snu_update_record_batch']) {
    const tool = getToolByName(name)!;
    const mapped = tool.mapInput({ table: 'sys_script_include', sys_id: sysId, name: 'Example', fieldsFile: 'fields.json' });
    assert.equal(mapped.params.script, undefined);
    assert.equal(mapped.params.fields.script, fields.script);
    assert.throws(() => tool.mapInput({ fields: {}, fieldsFile: 'fields.json' }), /not both/);
    assert.throws(() => tool.mapInput({ fields: [] }), /JSON object/);
  }
});
