import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneBridge } from '../server/standalone.js';
import { StandaloneHttpBridge } from '../server/httpBridge.js';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';

test('Standalone: WebSocket bridge starts, connects to mock client, and handles messages', async () => {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await (wsBridge as any).start();

  try {
    assert.strictEqual(wsBridge.hasBrowserClient(), false);

    // Connect mock browser client
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Wait 50ms for connection registration
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(wsBridge.hasBrowserClient(), true);

    // Send helper build info
    ws.send(
      JSON.stringify({
        action: 'helperBuildInfo',
        tier: 'pro',
        proFeatures: true,
      })
    );

    await new Promise((r) => setTimeout(r, 50));
    const helper = wsBridge.getHelperState();
    assert.strictEqual(helper.tier, 'pro');
    assert.strictEqual(helper.proFeatures, true);

    // Test request/response correlation
    const pendingPromise = pending.register({ id: 'test_req_1', command: 'test' });
    wsBridge.sendToBrowser({ action: 'test', agentRequestId: 'test_req_1' });

    ws.send(
      JSON.stringify({
        agentRequestId: 'test_req_1',
        success: true,
        data: 'hello from mock browser',
      })
    );

    const reply = await pendingPromise;
    assert.strictEqual(reply.data, 'hello from mock browser');

    ws.close();
  } finally {
    await wsBridge.close();
  }
});

test('Standalone: HTTP bridge serves health and handles yield command', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-standalone-test-'));
  let yielded = false;

  const bridge = new StandaloneBridge({
    cwd: tmpDir,
    httpPort: 0,
    wsPort: 0,
    onYield: () => {
      yielded = true;
    },
  });

  try {
    const { httpPort, token } = await bridge.start();

    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${httpPort}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    const health = (await healthRes.json()) as any;
    assert.strictEqual(health.status, 'success');
    assert.strictEqual(health.hostKind, 'standalone');
    assert.strictEqual(health.pid, process.pid);

    // 2. Yield command
    const yieldRes = await fetch(`http://127.0.0.1:${httpPort}/api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': token,
      },
      body: JSON.stringify({ id: 'test_yield', command: 'yield' }),
    });

    assert.strictEqual(yieldRes.status, 200);
    const yieldData = (await yieldRes.json()) as any;
    assert.strictEqual(yieldData.result.yielded, true);

    // Wait 100ms for yield callback
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(yielded, true);
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Standalone: completed request body does not cancel a pending command', async () => {
  let cancelReason: string | undefined;
  const dispatcher = {
    async dispatch(request: any) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        id: request.id,
        status: 'success',
        result: { table: request.params.table },
      };
    },
    cancel(_id: string, reason: string) {
      cancelReason = reason;
      return true;
    },
  };

  const bridge = new StandaloneHttpBridge({
    port: 0,
    token: 'test-token',
    dispatcher: dispatcher as any,
  });

  try {
    const port = await bridge.start();
    const response = await fetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': 'test-token',
      },
      body: JSON.stringify({
        id: 'schema_request',
        command: 'get_table_metadata',
        params: { table: 'sys_user' },
      }),
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual((await response.json()) as any, {
      id: 'schema_request',
      status: 'success',
      result: { table: 'sys_user' },
    });
    assert.strictEqual(cancelReason, undefined);
  } finally {
    await bridge.close();
  }
});
