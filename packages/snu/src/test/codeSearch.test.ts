import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';

// Spin up a ws bridge + dispatcher with a mock helper tab answering
// agentCodeSearch. Mirrors the harness in restRequest.test.ts.
async function withBridge(
  onSearch: (request: any, reply: (payload: any) => void) => void,
  body: (dispatcher: StandaloneDispatcher) => Promise<void>
) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-codesearch-test-'));
  const dispatcher = new StandaloneDispatcher({ cwd: tmpDir, wsBridge, pending, cliFlags: {} } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

  try {
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({
      instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'live-session-token' },
    }));
    await new Promise((r) => setTimeout(r, 20));

    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.action !== 'agentCodeSearch') return;
      onSearch(request, (payload) =>
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

// Regression for sn-scriptsync#164: the helper tab reads searchTerm and an
// options object (the VS Code host shape), not top-level term/limit.
test('code_search: sends searchTerm and options in the helper tab shape', async () => {
  let seen: any = null;
  await withBridge((request, reply) => {
    seen = request;
    reply({
      success: true,
      searchTerm: request.searchTerm,
      stats: { tables: 1, records: 1, matches: 2 },
      words: ['myfunctionname'],
      results: [{ table: 'sys_script_include', label: 'Script Include', hits: [] }],
    });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({
      id: 'cs_1',
      command: 'code_search',
      params: { term: '  myFunctionName ', limit: 25, tables: ' sys_script_include ', activeOnly: true },
    });

    assert.strictEqual(seen.searchTerm, 'myFunctionName');
    assert.deepStrictEqual(seen.options, { activeOnly: true, limit: 25, tables: 'sys_script_include' });
    assert.strictEqual(seen.term, undefined);

    assert.strictEqual(response.status, 'success');
    const result = response.result as any;
    assert.strictEqual(result.term, 'myFunctionName');
    assert.deepStrictEqual(result.stats, { tables: 1, records: 1, matches: 2 });
    assert.deepStrictEqual(result.words, ['myfunctionname']);
    assert.strictEqual(result.results.length, 1);
  });
});

test('code_search: defaults limit to 50 and omits an empty table filter', async () => {
  let seen: any = null;
  await withBridge((request, reply) => {
    seen = request;
    reply({ success: true, results: [] });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({ id: 'cs_2', command: 'code_search', params: { term: 'GlideRecord', tables: ' ' } });
    assert.deepStrictEqual(seen.options, { activeOnly: false, limit: 50 });
    assert.strictEqual((response.result as any).term, 'GlideRecord');
  });
});

test('code_search: a short term is refused before reaching the browser', async () => {
  let reached = false;
  await withBridge(() => { reached = true; }, async (dispatcher) => {
    const response = await dispatcher.dispatch({ id: 'cs_3', command: 'code_search', params: { term: 'x' } });
    assert.strictEqual(response.status, 'error');
    assert.strictEqual((response as any).code, 'E_INVALID_PARAMS');
    assert.strictEqual(reached, false);
  });
});
