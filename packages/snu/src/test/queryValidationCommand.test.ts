import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { VECTOR_PARENTS, VECTOR_SCHEMA } from '../server/queryValidationVectors.js';

// query_records end to end through the real bridge, with a helper tab that
// answers ui/meta from the vector schema and the query with one record.
async function withHelper(body: (dispatcher: StandaloneDispatcher, sent: any[]) => Promise<void>) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-qv-test-'));
  const dispatcher = new StandaloneDispatcher({ cwd, wsBridge, pending, cliFlags: {} } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const sent: any[] = [];
  try {
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'token' } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.action !== 'agentRestApi') return;
      sent.push(request);
      const meta = /^\/api\/now\/ui\/meta\/(.+)$/.exec(request.endpoint);
      const columns = meta ? VECTOR_SCHEMA[meta[1]] : undefined;
      const parent = request.endpoint === '/api/now/table/sys_db_object' ? VECTOR_PARENTS[String(request.queryParams.sysparm_query).replace('name=', '')] : undefined;
      const payload = request.endpoint === '/api/now/table/sys_db_object'
        ? (parent === null || parent === undefined ? { success: false, status: 403, error: 'ACL' } : { success: true, status: 200, data: { result: [{ 'super_class.name': parent }] } })
        : !meta ? { success: true, status: 200, data: { result: [{ sys_id: '1' }] } }
        : columns === null ? { success: false, status: 403, error: 'ACL' }
        : { success: true, status: 200, data: { result: { columns: columns || {} } } };
      ws.send(JSON.stringify({ agentRequestId: request.agentRequestId, ...payload }));
    });
    await body(dispatcher, sent);
  } finally {
    ws.close();
    await wsBridge.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('query_records: an invalid dot-walk fails with E_INVALID_QUERY and the query is not run', async () => {
  await withHelper(async (dispatcher, sent) => {
    const response = await dispatcher.dispatch({ id: 'q', command: 'query_records', instance: 'dev123',
      params: { table: 'question_choice', query: 'question.cat_item=73da21de97085f14c3e2fc90f053aff3', fields: 'text,value' } });
    assert.equal(response.status, 'error');
    assert.equal(response.code, 'E_INVALID_QUERY');
    assert.equal(response.details!.problems[0].hop, 'cat_item');
    assert.deepEqual(sent.map((m) => m.endpoint), ['/api/now/ui/meta/question_choice', '/api/now/ui/meta/question']);
  });
});

test('query_records: a valid query returns the unchanged result and reuses cached columns', async () => {
  await withHelper(async (dispatcher, sent) => {
    const first = await dispatcher.dispatch({ id: 'q1', command: 'query_records', instance: 'dev123', params: { table: 'incident', query: 'priority=1' } });
    assert.deepEqual(first.result, { table: 'incident', count: 1, records: [{ sys_id: '1' }] });
    sent.length = 0;
    await dispatcher.dispatch({ id: 'q2', command: 'query_records', instance: 'dev123', params: { table: 'incident', query: 'priority=2' } });
    assert.deepEqual(sent.map((m) => m.endpoint), ['/api/now/table/incident']);
  });
});

test('query_records: unreadable columns are E_QUERY_UNVERIFIABLE unless validate is false', async () => {
  await withHelper(async (dispatcher, sent) => {
    const refused = await dispatcher.dispatch({ id: 'q', command: 'query_records', instance: 'dev123', params: { table: 'cmn_department', query: 'name=IT' } });
    assert.equal(refused.code, 'E_QUERY_UNVERIFIABLE');
    sent.length = 0;
    const unchecked = await dispatcher.dispatch({ id: 'q2', command: 'query_records', instance: 'dev123', params: { table: 'cmn_department', query: 'name=IT', validate: false } });
    assert.equal(unchecked.status, 'success', unchecked.error);
    assert.deepEqual(sent.map((m) => m.endpoint), ['/api/now/table/cmn_department']);
  });
});

test('query_records: a ref_ cast is proven through the table hierarchy before the query runs', async () => {
  await withHelper(async (dispatcher, sent) => {
    const ok = await dispatcher.dispatch({ id: 'q', command: 'query_records', instance: 'dev123', params: { table: 'question_choice', query: 'question.ref_item_option_new.cat_item=x' } });
    assert.equal(ok.status, 'success', ok.error);
    assert.ok(sent.some((m) => m.endpoint === '/api/now/table/sys_db_object' && m.queryParams.sysparm_query === 'name=item_option_new'));
    const bad = await dispatcher.dispatch({ id: 'q2', command: 'query_records', instance: 'dev123', params: { table: 'incident', query: 'caller_id.ref_incident.priority=1' } });
    assert.equal(bad.code, 'E_INVALID_QUERY');
  });
});
