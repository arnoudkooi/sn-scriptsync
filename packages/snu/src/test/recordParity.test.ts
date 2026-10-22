import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';

// query_records, get_record and delete_record must answer like the VS Code
// host (src/agent/commands/query.ts, records.ts): raw values, so dates are
// UTC and choices are their stored values, and a missing record is
// E_NOT_FOUND. Mirrors the harness in restRequest.test.ts.
async function withBridge(
  cliFlags: Record<string, any>,
  onRestRequest: (request: any, reply: (payload: any) => void) => void,
  body: (dispatcher: StandaloneDispatcher) => Promise<void>
) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-record-parity-'));
  const dispatcher = new StandaloneDispatcher({ cwd: tmpDir, wsBridge, pending, cliFlags } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

  try {
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({
      instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'live-session-token' },
    }));
    await new Promise((r) => setTimeout(r, 20));

    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.action !== 'agentRestApi') return;
      onRestRequest(request, (payload) =>
        ws.send(JSON.stringify({ agentRequestId: request.agentRequestId, ...payload }))
      );
    });

    await body(dispatcher);
  } finally {
    ws.close();
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('query_records: asks for raw values, like the VS Code host', async () => {
  let seen: any = null;
  await withBridge({}, (request, reply) => {
    seen = request;
    reply({ success: true, status: 200, data: { result: [{ sys_id: 'a1', state: '2', sys_created_on: '2026-10-18 20:00:00' }] } });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'q_raw',
      command: 'query_records',
      params: { table: 'incident', query: 'active=true', fields: 'sys_id,state,sys_created_on', limit: 5, validate: false },
    });
    assert.strictEqual(response.status, 'success');
    assert.strictEqual(seen.queryParams.sysparm_display_value, undefined, 'no display values (time zone and labels would differ from VS Code)');
    assert.deepStrictEqual((response.result as any).records, [{ sys_id: 'a1', state: '2', sys_created_on: '2026-10-18 20:00:00' }]);
  });
});

test('get_record: asks for raw values, like the VS Code host', async () => {
  let seen: any = null;
  await withBridge({}, (request, reply) => {
    seen = request;
    reply({ success: true, status: 200, data: { result: { sys_id: 'a1', state: '2' } } });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({ id: 'g_raw', command: 'get_record', params: { table: 'incident', sys_id: 'a1' } });
    assert.strictEqual(response.status, 'success');
    assert.strictEqual(seen.queryParams.sysparm_display_value, 'false');
  });
});

test('get_record: a denied read is E_ACL, not E_COMMAND_FAILED', async () => {
  await withBridge({}, (_request, reply) => {
    reply({ success: false, status: 403, error: 'Insufficient rights' });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({ id: 'g_acl', command: 'get_record', params: { table: 'incident', sys_id: 'a1' } });
    assert.strictEqual(response.code, 'E_ACL');
  });
});

test('delete_record: a record that is not there is E_NOT_FOUND', async () => {
  await withBridge({ deleteRecords: true, reviewHighRisk: false }, (_request, reply) => {
    reply({ success: false, status: 404, error: 'No Record found' });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({ id: 'd_404', command: 'delete_record', params: { table: 'incident', sys_id: 'a1' } });
    assert.strictEqual(response.status, 'error');
    assert.strictEqual(response.code, 'E_NOT_FOUND');
  });
});
