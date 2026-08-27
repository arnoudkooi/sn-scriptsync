import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';

const SCOPE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

// Mock helper tab answering agentRestApi — mirrors restRequest.test.ts.
async function withBridge(
  onRestRequest: (request: any, reply: (payload: any) => void) => void,
  body: (dispatcher: StandaloneDispatcher) => Promise<void>
) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-scope-test-'));
  const dispatcher = new StandaloneDispatcher({ cwd: tmpDir, wsBridge, pending, cliFlags: { createArtifacts: true } } as any);
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

test('create_artifact: named scope resolves to sys_id and sets transaction scope + sys_scope', async () => {
  const posts: any[] = [];
  await withBridge((request, reply) => {
    if (request.method === 'GET' && request.endpoint === '/api/now/table/sys_scope') {
      assert.strictEqual(request.queryParams.sysparm_query, 'scope=x_acme_app');
      reply({ success: true, status: 200, data: { result: [{ sys_id: SCOPE_ID, scope: 'x_acme_app' }] } });
      return;
    }
    posts.push(request);
    reply({ success: true, status: 201, data: { result: { sys_id: 'new123', name: 'MyUtils' } } });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'ca_1',
      command: 'create_artifact',
      params: { table: 'sys_script_include', scope: 'x_acme_app', fields: { name: 'MyUtils', script: 'var x=1;' } },
    });
    assert.strictEqual(response.status, 'success');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].queryParams.sysparm_transaction_scope, SCOPE_ID);
    assert.strictEqual(posts[0].body.sys_scope, SCOPE_ID);
    assert.strictEqual(posts[0].body.name, 'MyUtils');
  });
});

test('create_artifact: a scope sys_id is used directly, no lookup roundtrip', async () => {
  const requests: any[] = [];
  await withBridge((request, reply) => {
    requests.push(request);
    reply({ success: true, status: 201, data: { result: { sys_id: 'new123' } } });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'ca_2',
      command: 'create_artifact',
      params: { table: 'sys_script_include', scope: SCOPE_ID, fields: { name: 'MyUtils', script: '' } },
    });
    assert.strictEqual(response.status, 'success');
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, 'POST');
    assert.strictEqual(requests[0].queryParams.sysparm_transaction_scope, SCOPE_ID);
  });
});

test('create_artifact: global/omitted scope adds nothing', async () => {
  const requests: any[] = [];
  await withBridge((request, reply) => {
    requests.push(request);
    reply({ success: true, status: 201, data: { result: { sys_id: 'new123' } } });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'ca_3',
      command: 'create_artifact',
      params: { table: 'sys_script_include', scope: 'global', fields: { name: 'MyUtils', script: '' } },
    });
    assert.strictEqual(response.status, 'success');
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].queryParams, undefined);
    assert.strictEqual(requests[0].body.sys_scope, undefined);
  });
});

test('create_artifact: an unknown scope name fails instead of creating in global', async () => {
  await withBridge((request, reply) => {
    if (request.method === 'GET' && request.endpoint === '/api/now/table/sys_scope') {
      reply({ success: true, status: 200, data: { result: [] } });
      return;
    }
    assert.fail('No create should be attempted for an unknown scope');
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'ca_4',
      command: 'create_artifact',
      params: { table: 'sys_script_include', scope: 'x_nope', fields: { name: 'MyUtils', script: '' } },
    });
    assert.strictEqual(response.status, 'error');
    assert.strictEqual(response.code, 'E_INVALID_PARAMS');
    assert.match(String(response.error), /Unknown application scope 'x_nope'/);
  });
});

test('create_record: named scope sets the transaction scope on the insert', async () => {
  const posts: any[] = [];
  await withBridge((request, reply) => {
    if (request.method === 'GET' && request.endpoint === '/api/now/table/sys_scope') {
      reply({ success: true, status: 200, data: { result: [{ sys_id: { value: SCOPE_ID } }] } });
      return;
    }
    posts.push(request);
    reply({ success: true, status: 201, data: { result: { sys_id: 'row1' } } });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'cr_1',
      command: 'create_record',
      params: { table: 'x_acme_app_task', scope: 'x_acme_app', fields: { short_description: 'demo' } },
    });
    assert.strictEqual(response.status, 'success');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].queryParams.sysparm_transaction_scope, SCOPE_ID);
    assert.strictEqual(posts[0].queryParams.sysparm_display_value, 'false');
    // Plain data rows carry no sys_scope column; only the transaction scope matters.
    assert.strictEqual(posts[0].body.sys_scope, undefined);
  });
});
