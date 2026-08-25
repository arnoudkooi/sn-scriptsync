import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { getToolByName, getToolByCliCommand } from '../registry.js';
import { resolveStandaloneConfig } from '../server/config.js';
import { getCommandPolicy } from '../server/policy.js';

// Spin up a ws bridge + dispatcher with a mock helper tab answering
// agentRestApi. Mirrors the harness in standalone.test.ts.
async function withBridge(
  cliFlags: Record<string, any>,
  onRestRequest: (request: any, reply: (payload: any) => void) => void,
  body: (dispatcher: StandaloneDispatcher) => Promise<void>
) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-rest-test-'));
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

test('rest_request: standalone dispatcher forwards to the browser helper', async () => {
  let seen: any = null;
  await withBridge({ restRequest: true }, (request, reply) => {
    seen = request;
    reply({ success: true, status: 201, data: { result: { sys_id: 'abc123', number: 'INC0010001' } } });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'rest_1',
      command: 'rest_request',
      params: { endpoint: '/api/now/table/incident', method: 'POST', body: { short_description: 'Printer down' } },
    });

    assert.strictEqual(response.status, 'success');
    assert.strictEqual((response.result as any).status, 201);
    assert.deepStrictEqual((response.result as any).data.result, { sys_id: 'abc123', number: 'INC0010001' });

    assert.strictEqual(seen.endpoint, '/api/now/table/incident');
    assert.strictEqual(seen.method, 'POST');
    assert.deepStrictEqual(seen.body, { short_description: 'Printer down' });
    assert.strictEqual(seen.instance.g_ck, 'live-session-token');
  });
});

test('rest_request: a GET needs no gate', async () => {
  await withBridge({ restRequest: false }, (request, reply) => {
    reply({ success: true, status: 200, data: { result: [] } });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'rest_get',
      command: 'rest_request',
      params: { endpoint: '/api/now/table/incident', queryParams: { sysparm_limit: '1' } },
    });
    assert.strictEqual(response.status, 'success');
    assert.strictEqual((response.result as any).status, 200);
  });
});

test('rest_request: a write is refused when the restRequest gate is closed', async () => {
  await withBridge({ restRequest: false }, () => {
    assert.fail('gated write must never reach the browser');
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'rest_gated',
      command: 'rest_request',
      params: { endpoint: '/api/now/table/incident', method: 'POST', body: { short_description: 'x' } },
    });
    assert.strictEqual(response.status, 'error');
    assert.strictEqual(response.code, 'E_DISABLED');
    // The remediation must name the variable config.ts actually reads, and must
    // steer away from the browser-UI workaround.
    assert.match(response.error || '', /SNU_ALLOW_REST_REQUEST=1/);
    assert.match(response.error || '', /browser UI/i);
  });
});

test('rest_request: validates endpoint and method before touching the browser', async () => {
  await withBridge({ restRequest: true }, () => {
    assert.fail('invalid params must never reach the browser');
  }, async (dispatcher) => {
    const noSlash = await dispatcher.dispatch({
      id: 'rest_bad_endpoint',
      command: 'rest_request',
      params: { endpoint: 'api/now/table/incident' },
    });
    assert.strictEqual(noSlash.code, 'E_INVALID_PARAMS');

    const badMethod = await dispatcher.dispatch({
      id: 'rest_bad_method',
      command: 'rest_request',
      params: { endpoint: '/api/now/table/incident', method: 'TRACE' },
    });
    assert.strictEqual(badMethod.code, 'E_INVALID_PARAMS');
  });
});

test('rest_request: HTTP failures map onto Agent API codes', async () => {
  await withBridge({ restRequest: true }, (_request, reply) => {
    reply({ success: false, status: 404, error: 'No Record found' });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'rest_404',
      command: 'rest_request',
      params: { endpoint: '/api/now/table/incident/deadbeef' },
    });
    assert.strictEqual(response.status, 'error');
    assert.strictEqual(response.code, 'E_NOT_FOUND');
  });
});

test('snu_create_record: maps onto the first-class create_record command', () => {
  const tool = getToolByName('snu_create_record');
  assert.ok(tool);

  const mapped = tool!.mapInput({ table: 'incident', fields: { short_description: 'Printer down' }, instance: 'dev123' });
  assert.strictEqual(mapped.command, 'create_record');
  assert.strictEqual(mapped.instance, 'dev123');
  assert.deepStrictEqual(mapped.params, { table: 'incident', fields: { short_description: 'Printer down' } });
});

test('create_record: inserts through the browser and returns the created record', async () => {
  let seen: any = null;
  // createArtifacts is on by default, so no gate flag is needed here: that is
  // the whole point of putting create_record on that gate.
  await withBridge({}, (request, reply) => {
    seen = request;
    reply({ success: true, status: 201, data: { result: { sys_id: 'abc123', number: 'INC0010001', short_description: 'Printer down' } } });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'create_1',
      command: 'create_record',
      params: { table: 'incident', fields: { short_description: 'Printer down' } },
    });

    assert.strictEqual(response.status, 'success');
    const result = response.result as any;
    assert.strictEqual(result.created, true);
    assert.strictEqual(result.table, 'incident');
    assert.strictEqual(result.sys_id, 'abc123');
    assert.strictEqual(result.name, 'INC0010001');

    assert.strictEqual(seen.endpoint, '/api/now/table/incident');
    assert.strictEqual(seen.method, 'POST');
    assert.deepStrictEqual(seen.body, { short_description: 'Printer down' });
  });
});

test('create_record: refused when the createArtifacts gate is closed', async () => {
  await withBridge({ createArtifacts: false }, () => {
    assert.fail('gated insert must never reach the browser');
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'create_gated',
      command: 'create_record',
      params: { table: 'incident', fields: { short_description: 'x' } },
    });
    assert.strictEqual(response.code, 'E_DISABLED');
    assert.match(response.error || '', /SNU_ALLOW_CREATE_ARTIFACTS=1/);
  });
});

test('create_record: validates table and payload before touching the browser', async () => {
  await withBridge({}, () => {
    assert.fail('invalid params must never reach the browser');
  }, async (dispatcher) => {
    const badTable = await dispatcher.dispatch({
      id: 'create_bad_table',
      command: 'create_record',
      params: { table: 'incident; drop', fields: { a: 1 } },
    });
    assert.strictEqual(badTable.code, 'E_INVALID_PARAMS');

    const noFields = await dispatcher.dispatch({
      id: 'create_no_fields',
      command: 'create_record',
      params: { table: 'incident', fields: {} },
    });
    assert.strictEqual(noFields.code, 'E_INVALID_PARAMS');
  });
});

test('Policy: create_record shares the createArtifacts gate with the other create commands', () => {
  const commands = ['create_artifact', 'create_record', 'create_application', 'create_table', 'add_column'];
  for (const command of commands) {
    const policy = getCommandPolicy({ id: '1', command, params: {} });
    assert.strictEqual(policy.risk, 'write', `${command} risk`);
    assert.deepStrictEqual(policy.gates, ['createArtifacts'], `${command} gates`);
  }
});

test('snu_create_record: rejects an empty payload and a bogus table name', () => {
  const tool = getToolByName('snu_create_record')!;
  assert.throws(() => tool.mapInput({ table: 'incident', fields: {} }), /fields/);
  assert.throws(() => tool.mapInput({ table: 'incident; drop', fields: { a: 1 } }), /table/);
});

test('snu_rest_request: validates endpoint and normalizes method', () => {
  const tool = getToolByName('snu_rest_request')!;
  assert.throws(() => tool.mapInput({ endpoint: 'api/now/table/incident' }), /endpoint/);
  assert.throws(() => tool.mapInput({ endpoint: '/api/now/table/incident', method: 'TRACE' }), /method/i);

  const mapped = tool.mapInput({ endpoint: '/api/now/table/incident', method: 'post', body: '{"a":1}' });
  assert.strictEqual(mapped.params.method, 'POST');
  assert.deepStrictEqual(mapped.params.body, { a: 1 });
});

test('snu_rest_request: CLI --query k=v pairs become queryParams', () => {
  const tool = getToolByCliCommand('rest')!;
  const mapped = tool.mapInput({ endpoint: '/api/now/table/incident', queryParams: 'sysparm_limit=1,sysparm_query=active=true' });
  assert.deepStrictEqual(mapped.params.queryParams, { sysparm_limit: '1', sysparm_query: 'active=true' });
});

test('Gates: every gate name resolves to an env var resolveStandaloneConfig reads', () => {
  const cases: Array<[string, string]> = [
    ['backgroundScripts', 'SNU_ALLOW_BACKGROUND_SCRIPTS'],
    ['deleteRecords', 'SNU_ALLOW_DELETE_RECORDS'],
    ['createArtifacts', 'SNU_ALLOW_CREATE_ARTIFACTS'],
    ['browserDebugger', 'SNU_ALLOW_BROWSER_DEBUGGER'],
    ['restRequest', 'SNU_ALLOW_REST_REQUEST'],
  ];

  for (const [gate, envVar] of cases) {
    const original = process.env[envVar];
    try {
      // createArtifacts defaults on, the rest default off: flip each away from
      // its default and assert the variable is the one actually consulted.
      const defaults = resolveStandaloneConfig();
      const flipped = (defaults.gates as any)[gate] ? '0' : '1';
      process.env[envVar] = flipped;
      const config = resolveStandaloneConfig();
      assert.strictEqual(
        (config.gates as any)[gate],
        flipped === '1',
        `${envVar} does not drive the ${gate} gate`
      );
    } finally {
      if (original === undefined) delete process.env[envVar];
      else process.env[envVar] = original;
    }
  }
});
