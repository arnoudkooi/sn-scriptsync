import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';

// Same harness shape as restRequest.test.ts: a ws bridge + dispatcher with a
// mock helper tab answering agentRestApi round-trips.
async function withBridge(
  onRestRequest: (request: any, reply: (payload: any) => void) => void,
  body: (dispatcher: StandaloneDispatcher, cwd: string) => Promise<void>
) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-pullscope-'));
  const dispatcher = new StandaloneDispatcher({ cwd: tmpDir, wsBridge, pending, cliFlags: {} } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  try {
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'tok' } }));
    await new Promise((r) => setTimeout(r, 20));
    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.action !== 'agentRestApi') return;
      onRestRequest(request, (payload) => ws.send(JSON.stringify({ agentRequestId: request.agentRequestId, ...payload })));
    });
    await body(dispatcher, tmpDir);
  } finally {
    ws.close();
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const SCOPE_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const row = (n: number) => ({ sys_id: n.toString(16).padStart(32, '0'), name: `Util${n}`, sys_name: `Util${n}`, 'sys_scope.scope': 'x_acme_app', script: `// ${n}` });

test('pull_scope: standalone host resolves the scope, discovers tables, pages, and writes files', async () => {
  const seen: any[] = [];
  await withBridge((request, reply) => {
    seen.push(request);
    const q: string = request.queryParams?.sysparm_query || '';
    if (request.endpoint === '/api/now/table/sys_scope') {
      return reply({ success: true, status: 200, data: { result: [{ sys_id: SCOPE_ID, scope: 'x_acme_app', name: 'Acme' }] } });
    }
    if (request.endpoint === '/api/now/table/sys_metadata') {
      return reply({ success: true, status: 200, data: { result: [
        ...Array.from({ length: 101 }, () => ({ sys_class_name: 'sys_script_include' })),
        { sys_class_name: 'sys_properties' },
      ] }, pagination: { totalCount: '102' } });
    }
    if (request.endpoint === '/api/now/table/sys_db_object') {
      return reply({ success: true, data: { result: ['sys_script_include', 'sys_properties'].map(name => ({ name, 'super_class.name': '' })) }, pagination: { totalCount: '2' } });
    }
    if (request.endpoint === '/api/now/table/sys_dictionary') {
      return reply({ success: true, data: { result: [
        { name: 'sys_script_include', element: 'script', 'internal_type.name': 'script' },
        { name: 'sys_properties', element: 'value', 'internal_type.name': 'string' },
      ] }, pagination: { totalCount: '2' } });
    }
    if (request.endpoint === '/api/now/table/sys_script_include') {
      const offset = Number(request.queryParams.sysparm_offset);
      const rows = offset === 0 ? Array.from({ length: 100 }, (_, i) => row(i + 1)) : [row(101)];
      assert.ok(q.includes(`sys_scope=${SCOPE_ID}`));
      return reply({ success: true, status: 200, data: { result: rows }, pagination: { totalCount: '101' } });
    }
    assert.fail(`unexpected endpoint ${request.endpoint}`);
  }, async (dispatcher, cwd) => {
    const response = await dispatcher.dispatch({ id: 'ps1', command: 'pull_scope', params: { scope: 'x_acme_app' } });
    assert.strictEqual(response.status, 'success', JSON.stringify(response));
    const result: any = response.result;
    assert.deepStrictEqual(result.scope, { name: 'x_acme_app', sys_id: SCOPE_ID });
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.totals.records, 101);
    assert.deepStrictEqual(result.skippedTables, [{ table: 'sys_properties', records: 1, reason: 'no_scriptable_fields' }]);
    assert.deepStrictEqual(seen.filter((r) => r.endpoint === '/api/now/table/sys_script_include').map((r) => r.queryParams.sysparm_offset), ['0', '100']);
    assert.ok(fs.existsSync(path.join(cwd, 'dev123', 'x_acme_app', 'sys_script_include', 'Util101.script.js')));
    const scopes = JSON.parse(fs.readFileSync(path.join(cwd, 'dev123', 'scopes.json'), 'utf8'));
    assert.strictEqual(scopes.x_acme_app, SCOPE_ID);
  });
});

test('pull_scope: global and malformed scopes are refused before any round-trip', async () => {
  await withBridge(() => assert.fail('must not reach the browser'), async (dispatcher) => {
    for (const scope of ['global', 'x acme']) {
      const response = await dispatcher.dispatch({ id: 'bad', command: 'pull_scope', params: { scope } });
      assert.strictEqual(response.status, 'error');
      assert.strictEqual((response as any).code, 'E_INVALID_PARAMS');
    }
  });
});

test('standalone continues through empty discovery pages and pulls an inherited field on an unknown table', async () => {
  const offsets: string[] = [];
  await withBridge((request, reply) => {
    const table = request.endpoint.split('/').pop();
    const send = (rows: any[], total = rows.length) => reply({ success: true, data: { result: rows }, pagination: { totalCount: String(total) } });
    if (table === 'sys_scope') return send([{ sys_id: SCOPE_ID, scope: 'x_acme_app' }]);
    if (table === 'sys_metadata') {
      offsets.push(request.queryParams.sysparm_offset);
      return send(request.queryParams.sysparm_offset === '1000' ? [{ sys_class_name: 'x_acme_script' }] : [], 1001);
    }
    if (table === 'sys_db_object') {
      return send(request.queryParams.sysparm_query.includes('nameINx_acme_script')
        ? [{ name: 'x_acme_script', 'super_class.name': 'sys_metadata' }]
        : [{ name: 'sys_metadata', 'super_class.name': '' }]);
    }
    if (table === 'sys_dictionary') return send([{ name: 'sys_metadata', element: 'markup', 'internal_type.name': 'xml' }]);
    if (table === 'x_acme_script') return send([{ ...row(7), markup: '<test/>' }]);
    reply({ success: false, error: `Unexpected table ${table}` });
  }, async (dispatcher, cwd) => {
    const response = await dispatcher.dispatch({ id: 'inherited', command: 'pull_scope', params: { scope: 'x_acme_app' } });
    assert.equal(response.status, 'success', JSON.stringify(response));
    assert.deepEqual(offsets, ['0', '500', '1000']);
    const result: any = response.result;
    assert.equal(result.complete, false, 'omitted metadata records are reported');
    assert.ok(result.warnings.some((w: string) => w.includes('1000 matching records were not returned')));
    assert.equal(fs.readFileSync(path.join(cwd, 'dev123/x_acme_app/x_acme_script/Util7.markup.xml'), 'utf8'), '<test/>');
  });
});
