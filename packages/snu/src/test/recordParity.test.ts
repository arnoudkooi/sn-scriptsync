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

const DISPLAY_FIELDS = 'sys_id,name,number,short_description,sys_class_name';

// The standalone handler read only table and sys_id, so a bulk delete by
// query sent DELETE /api/now/table/incident/undefined and reported the 404 as
// E_NOT_FOUND. It now runs the VS Code host's bulk mode (records.ts).
test('delete_record: bulk by query previews, deletes per row and reports each outcome', async () => {
  const requests: any[] = [];
  const rows = [
    { sys_id: 'a1', number: 'INC0001' },
    { sys_id: { value: 'b2', link: 'https://dev123.service-now.com/api/now/table/incident/b2' }, short_description: 'no number' },
    { sys_id: 'c3' },
  ];
  await withBridge({ deleteRecords: true, reviewHighRisk: false }, (request, reply) => {
    requests.push(request);
    if (request.method === 'GET') return reply({ success: true, status: 200, data: { result: rows } });
    if (request.endpoint.endsWith('/b2')) return reply({ success: false, status: 409, error: 'Cannot delete: referenced' });
    reply({ success: true, status: 204, data: null });
  }, async (dispatcher) => {
    const dry = await dispatcher.dispatch({ id: 'd_dry', command: 'delete_record', params: { table: 'incident', query: 'active=false', dryRun: true } });
    assert.strictEqual(dry.status, 'success', dry.error);
    assert.deepStrictEqual(dry.result, {
      dryRun: true, deleted: false, table: 'incident', count: 3, limit: 100,
      matches: [{ sys_id: 'a1', display: 'INC0001' }, { sys_id: 'b2', display: 'no number' }, { sys_id: 'c3', display: 'c3' }],
      message: 'Dry run: 3 record(s) would be deleted',
    });
    assert.deepStrictEqual(requests.map((r) => `${r.method} ${r.endpoint}`), ['GET /api/now/table/incident'], 'a dry run only reads');
    assert.deepStrictEqual(requests[0].queryParams, { sysparm_query: 'active=false', sysparm_fields: DISPLAY_FIELDS, sysparm_limit: '100', sysparm_display_value: 'false' });

    for (const params of [{ query: 'active=false', limit: 10 }, { query: 'active=false', confirm: true }, { query: 'active=false', confirm: true, limit: 0 }]) {
      const refused = await dispatcher.dispatch({ id: 'd_refused', command: 'delete_record', params: { table: 'incident', ...params } });
      assert.strictEqual(refused.code, 'E_CONFIRM_REQUIRED', JSON.stringify(params));
    }
    const neither = await dispatcher.dispatch({ id: 'd_neither', command: 'delete_record', params: { table: 'incident' } });
    assert.strictEqual(neither.code, 'E_INVALID_PARAMS');
    assert.strictEqual(requests.length, 1, 'a refused request reaches nothing');

    requests.length = 0;
    const partial = await dispatcher.dispatch({ id: 'd_bulk', command: 'delete_record', params: { table: 'incident', query: 'active=false', limit: 10, confirm: true } });
    assert.strictEqual(partial.status, 'error');
    assert.strictEqual(partial.code, 'E_PARTIAL_FAILURE');
    assert.strictEqual(partial.error, 'Deleted 2 of 3; 1 failed');
    assert.deepStrictEqual(partial.details?.results, [
      { sys_id: 'a1', display: 'INC0001', deleted: true },
      { sys_id: 'b2', display: 'no number', deleted: false, error: 'Cannot delete: referenced' },
      { sys_id: 'c3', display: 'c3', deleted: true },
    ]);
    assert.strictEqual(requests[0].queryParams.sysparm_limit, '10');
    assert.deepStrictEqual(requests.filter((r) => r.method === 'DELETE').map((r) => r.endpoint),
      ['/api/now/table/incident/a1', '/api/now/table/incident/b2', '/api/now/table/incident/c3']);
  });
});

test('delete_record: a bulk delete that removes every match, or matches nothing, succeeds', async () => {
  let rows: any[] = [{ sys_id: 'a1', name: 'Alpha' }, { sys_id: 'b2', name: 'Beta' }];
  await withBridge({ deleteRecords: true, reviewHighRisk: false }, (request, reply) => {
    if (request.method === 'GET') return reply({ success: true, status: 200, data: { result: rows } });
    reply({ success: true, status: 204, data: null });
  }, async (dispatcher) => {
    const all = await dispatcher.dispatch({ id: 'd_all', command: 'delete_record', params: { table: 'sys_user_group', query: 'nameSTARTSWITHtmp', limit: 5, confirm: true } });
    assert.strictEqual(all.status, 'success', all.error);
    assert.deepStrictEqual(all.result, { deleted: true, table: 'sys_user_group', count: 2, deletedCount: 2,
      results: [{ sys_id: 'a1', display: 'Alpha', deleted: true }, { sys_id: 'b2', display: 'Beta', deleted: true }] });
    rows = [];
    const none = await dispatcher.dispatch({ id: 'd_none', command: 'delete_record', params: { table: 'sys_user_group', query: 'nameSTARTSWITHtmp', limit: 5, confirm: true } });
    assert.deepStrictEqual(none.result, { deleted: true, table: 'sys_user_group', count: 0, deletedCount: 0, results: [] });
  });
});

test('delete_record: a single delete reads the record back first, and a dry run only reads', async () => {
  const requests: any[] = [];
  await withBridge({ deleteRecords: true, reviewHighRisk: false }, (request, reply) => {
    requests.push(request);
    if (request.method === 'GET') return reply({ success: true, status: 200, data: { result: { sys_id: 'a1', number: 'INC0001' } } });
    reply({ success: true, status: 204, data: null });
  }, async (dispatcher) => {
    const dry = await dispatcher.dispatch({ id: 'd_sdry', command: 'delete_record', params: { table: 'incident', sys_id: 'a1', dryRun: true } });
    assert.deepStrictEqual(dry.result, { dryRun: true, deleted: false, table: 'incident', sys_id: 'a1', display: 'INC0001', message: 'Dry run: record not deleted' });
    assert.ok(!requests.some((r) => r.method === 'DELETE'), 'a dry run deletes nothing');
    const del = await dispatcher.dispatch({ id: 'd_s', command: 'delete_record', params: { table: 'incident', sys_id: 'a1' } });
    assert.deepStrictEqual(del.result, { deleted: true, table: 'incident', sys_id: 'a1', display: 'INC0001' });
    assert.deepStrictEqual(requests.map((r) => `${r.method} ${r.endpoint}`),
      ['GET /api/now/table/incident/a1', 'GET /api/now/table/incident/a1', 'DELETE /api/now/table/incident/a1']);
    assert.deepStrictEqual(requests[0].queryParams, { sysparm_display_value: 'false', sysparm_fields: DISPLAY_FIELDS });
  });
});

test('delete_record: all rejected rows return an error with every outcome', async () => {
  await withBridge({ deleteRecords: true, reviewHighRisk: false }, (request, reply) => {
    if (request.method === 'GET') return reply({ success: true, status: 200, data: { result: [{ sys_id: 'a1' }, { sys_id: 'b2' }] } });
    reply({ success: false, status: 403, error: 'ACL denied' });
  }, async dispatcher => {
    const response = await dispatcher.dispatch({ id: 'd_fail', command: 'delete_record', params: { table: 'incident', query: 'active=false', limit: 2, confirm: true } });
    assert.strictEqual(response.status, 'error');
    assert.strictEqual(response.code, 'E_PARTIAL_FAILURE');
    assert.strictEqual(response.error, 'Deleted 0 of 2; 2 failed');
    assert.deepStrictEqual(response.details?.results, [
      { sys_id: 'a1', display: 'a1', deleted: false, error: 'ACL denied' },
      { sys_id: 'b2', display: 'b2', deleted: false, error: 'ACL denied' },
    ]);
  });
});
