import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';

// End-to-end through the real WebSocket bridge with a scripted helper tab:
// the bridge's own handling of coded helper failures (it rejects them) is part
// of what these tests cover.

const SYS_ID = '68cf699a97485f14c3e2fc90f053af5d';
const INSTANCE = { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'old-token' };

type Answer = (request: any, ws: WebSocket) => any | undefined;

async function withHelper(
  options: { capabilities?: Record<string, any>; cliFlags?: Record<string, any> },
  answer: Answer,
  body: (dispatcher: StandaloneDispatcher, ctx: { sent: any[]; cwd: string; ws: WebSocket }) => Promise<void>,
) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-attach-test-'));
  const dispatcher = new StandaloneDispatcher({ cwd, wsBridge, pending, cliFlags: options.cliFlags || {} } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const sent: any[] = [];
  try {
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ instance: INSTANCE }));
    if (options.capabilities) ws.send(JSON.stringify({ action: 'helperBuildInfo', capabilities: options.capabilities }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (!request.agentRequestId) return;
      sent.push(request);
      const payload = answer(request, ws);
      if (payload !== undefined && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ agentRequestId: request.agentRequestId, ...payload }));
      }
    });
    await body(dispatcher, { sent, cwd, ws });
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await wsBridge.close();
    pending.rejectAll('E_CANCELLED', 'Test finished');
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** Answer a /token request by pushing a fresh session, as the helper tab does. */
function tokenRefresh(request: any, ws: WebSocket) {
  setTimeout(() => ws.send(JSON.stringify({ instance: { ...INSTANCE, g_ck: 'fresh-token' } })), 10);
  return { success: true };
}

function attachmentReply(bytes: Buffer) {
  return {
    success: true, sysId: SYS_ID, fileName: 'lineup.png', contentType: 'image/png', tableName: 'sc_cat_item', tableSysId: 'a'.repeat(32),
    sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64'),
  };
}

const scripts = (request: any) => request.action === 'agentRunBackgroundScript';

test('run_background_script: a refused session is refreshed once and the result is structured', async () => {
  let runs = 0;
  await withHelper({ cliFlags: { backgroundScripts: true } }, (request, ws) => {
    if (request.action === 'runSlashCommand') return tokenRefresh(request, ws);
    if (scripts(request)) {
      runs++;
      return runs === 1
        ? { success: false, code: 'E_UNAUTHORIZED', error: 'not authorized', details: { notStarted: true } }
        : { success: true, output: "Script execution history <A HREF='sys_script_execution_history.do?sys_id=47eea1d697485f14c3e2fc90f053af06'>x</A><PRE>*** Script: ok<BR/></PRE>" };
    }
  }, async (dispatcher, { sent }) => {
    const response = await dispatcher.dispatch({ id: 'bg', command: 'run_background_script', params: { script: 'gs.print("ok")' }, instance: 'dev123' });
    assert.equal(response.status, 'success', response.error);
    assert.deepEqual(sent.map((m) => m.action), ['agentRunBackgroundScript', 'runSlashCommand', 'agentRunBackgroundScript']);
    assert.equal(sent[2].instance.g_ck, 'fresh-token');
    assert.equal(response.result.executed, true);
    assert.equal(response.result.stdout, 'ok');
    assert.equal(response.result.executionId, '47eea1d697485f14c3e2fc90f053af06');
  });
});

test('run_background_script: a second attempt cut off by a disconnect keeps its own code, not E_UNAUTHORIZED', async () => {
  let runs = 0;
  await withHelper({ cliFlags: { backgroundScripts: true } }, (request, ws) => {
    if (request.action === 'runSlashCommand') return tokenRefresh(request, ws);
    if (scripts(request)) {
      runs++;
      if (runs === 1) return { success: false, code: 'E_UNAUTHORIZED', error: 'not authorized' };
      setTimeout(() => ws.close(), 5); // the run may still be going on the instance
      return undefined;
    }
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({ id: 'bg', command: 'run_background_script', params: { script: 'x' }, instance: 'dev123' });
    assert.equal(response.status, 'error');
    assert.equal(response.code, 'E_BROWSER_DISCONNECTED');
    assert.equal(runs, 2);
  });
});

for (const unproven of [
  { success: false, code: 'E_ACL', error: 'User not authorized' },
  { success: false, code: 'E_DISABLED', error: 'Blocked', details: { notStarted: true } },
  { success: false, error: 'request not authorized by proxy' },
]) {
  test(`run_background_script: no proof it never ran (${unproven.code || 'message only'}) is never replayed`, async () => {
    await withHelper({ cliFlags: { backgroundScripts: true } }, (request) => (scripts(request) ? unproven : { success: true }), async (dispatcher, { sent }) => {
      const response = await dispatcher.dispatch({ id: 'bg', command: 'run_background_script', params: { script: 'x' }, instance: 'dev123' });
      assert.equal(response.status, 'error');
      assert.deepEqual(sent.map((m) => m.action), ['agentRunBackgroundScript']);
    });
  });
}

test('download_attachment: a helper without the capability is refused before anything is sent', async () => {
  await withHelper({}, () => ({ success: true }), async (dispatcher, { sent }) => {
    const response = await dispatcher.dispatch({ id: 'dl', command: 'download_attachment', params: { sys_id: SYS_ID }, instance: 'dev123' });
    assert.equal(response.code, 'E_UNSUPPORTED_HELPER');
    assert.equal(sent.length, 0);
  });
});

test('download_attachment: bytes go to a workspace file; the result has the path, not the bytes', async () => {
  const bytes = crypto.randomBytes(4096);
  await withHelper({ capabilities: { attachmentDownload: 1 } }, (request) => attachmentReply(bytes), async (dispatcher, { sent, cwd }) => {
    const response = await dispatcher.dispatch({ id: 'dl', command: 'download_attachment', params: { sys_id: SYS_ID }, instance: 'dev123' });
    assert.equal(response.status, 'success', response.error);
    assert.equal(sent[0].action, 'agentDownloadAttachment');
    assert.equal(sent[0].maxBytes, 50 * 1024 * 1024);
    assert.equal(response.result.filePath, path.join(cwd, 'dev123', 'attachments', SYS_ID, 'lineup.png'));
    assert.deepEqual(fs.readFileSync(response.result.filePath), bytes);
    assert.equal(JSON.stringify(response.result).includes(bytes.toString('base64')), false);
  });
});

test('download_attachment: the helper\'s E_TOO_LARGE is passed on and nothing is written', async () => {
  await withHelper({ capabilities: { attachmentDownload: 1 } }, () => ({ success: false, code: 'E_TOO_LARGE', error: 'larger than the limit' }), async (dispatcher, { cwd }) => {
    const response = await dispatcher.dispatch({ id: 'dl', command: 'download_attachment', params: { sys_id: SYS_ID, filePath: 'big.bin' }, instance: 'dev123' });
    assert.equal(response.code, 'E_TOO_LARGE');
    assert.equal(fs.existsSync(path.join(cwd, 'dev123', 'big.bin')), false);
  });
});

test('delete_attachment: dryRun only reads; a delete reads, then calls the Attachment API', async () => {
  const meta = { success: true, status: 200, data: { result: { sys_id: SYS_ID, file_name: 'lineup.png', table_name: 'sc_cat_item', table_sys_id: 'a'.repeat(32), size_bytes: '1748088' } } };
  await withHelper({ cliFlags: { deleteRecords: true } }, (request) => (request.method === 'DELETE' ? { success: true, status: 204, data: '' } : meta), async (dispatcher, { sent }) => {
    const preview = await dispatcher.dispatch({ id: 'del', command: 'delete_attachment', params: { sys_id: SYS_ID, dryRun: true }, instance: 'dev123' });
    assert.deepEqual(preview.result, { dryRun: true, deleted: false, sys_id: SYS_ID, fileName: 'lineup.png', table: 'sc_cat_item', tableSysId: 'a'.repeat(32), sizeBytes: 1748088 });
    assert.deepEqual(sent.map((m) => `${m.method} ${m.endpoint}`), [`GET /api/now/attachment/${SYS_ID}`]);
    const deleted = await dispatcher.dispatch({ id: 'del2', command: 'delete_attachment', params: { sys_id: SYS_ID }, instance: 'dev123' });
    assert.equal(deleted.result.deleted, true);
    assert.equal(sent.at(-1).method, 'DELETE');
    assert.equal(sent.at(-1).endpoint, `/api/now/attachment/${SYS_ID}`);
  });
});

test('delete_attachment: a missing attachment is E_NOT_FOUND and nothing is deleted', async () => {
  await withHelper({ cliFlags: { deleteRecords: true } }, () => ({ success: false, status: 404, error: 'Record not found' }), async (dispatcher, { sent }) => {
    const response = await dispatcher.dispatch({ id: 'del', command: 'delete_attachment', params: { sys_id: SYS_ID }, instance: 'dev123' });
    assert.equal(response.code, 'E_NOT_FOUND');
    assert.equal(sent.filter((m) => m.method === 'DELETE').length, 0);
  });
});
