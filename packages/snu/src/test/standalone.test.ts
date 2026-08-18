import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { StandaloneBridge } from '../server/standalone.js';
import { StandaloneHttpBridge } from '../server/httpBridge.js';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';

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

    // `/token` is an unsolicited instance push. Standalone mode must retain it
    // in memory so subsequent CLI commands have both a target URL and session.
    ws.send(JSON.stringify({
      instance: {
        name: 'dev123',
        url: 'https://dev123.service-now.com',
        g_ck: 'live-session-token',
      },
    }));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(wsBridge.getLiveInstances().map(({ name, url, g_ck }) => ({ name, url, g_ck })), [{
      name: 'dev123',
      url: 'https://dev123.service-now.com',
      g_ck: 'live-session-token',
    }]);

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

test('Standalone: query uses the most recently authenticated /token instance', async () => {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-live-instance-test-'));
  const dispatcher = new StandaloneDispatcher({ cwd: tmpDir, wsBridge, pending });
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

  try {
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({
      instance: {
        name: 'dev123',
        url: 'https://dev123.service-now.com',
        g_ck: 'live-session-token',
      },
    }));
    await new Promise((r) => setTimeout(r, 20));

    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.action !== 'agentRestApi') return;
      assert.strictEqual(request.instance.url, 'https://dev123.service-now.com');
      assert.strictEqual(request.instance.g_ck, 'live-session-token');
      ws.send(JSON.stringify({
        agentRequestId: request.agentRequestId,
        success: true,
        data: { result: [{ sys_id: 'abc123', number: 'INC0010001' }] },
      }));
    });

    const response = await dispatcher.dispatch({
      id: 'query_live_instance',
      command: 'query_records',
      params: { table: 'incident', query: 'active=true', limit: 1 },
    });

    assert.strictEqual(response.status, 'success');
    assert.deepStrictEqual((response.result as any).records, [{ sys_id: 'abc123', number: 'INC0010001' }]);

    const roster = await dispatcher.dispatch({ id: 'list_live_instances', command: 'list_instances', params: {} });
    assert.strictEqual((roster.result as any).defaultInstance, 'dev123');
    assert.strictEqual((roster.result as any).instances[0].source, 'browser');
  } finally {
    ws.close();
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Standalone: HTTP bridge serves health and handles yield command', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-standalone-test-'));
  let yielded = false;

  const bridge = new StandaloneBridge({
    cwd: tmpDir,
    httpPort: 0,
    wsPort: 0,
    portFileMode: 'workspace-only',
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

test('Standalone: SIGTERM closes the daemon and removes its port file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-signal-test-'));
  const modulePath = path.resolve(__dirname, '../server/standalone.js');
  const script = `
    const { StandaloneBridge } = require(${JSON.stringify(modulePath)});
    const bridge = new StandaloneBridge({ cwd: ${JSON.stringify(tmpDir)}, httpPort: 0, wsPort: 0, portFileMode: 'workspace-only' });
    bridge.start().then(() => process.stdout.write('READY\\n'));
  `;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child bridge did not start')), 3000);
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', reject);
    });

    child.kill('SIGTERM');
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child bridge did not exit after SIGTERM')), 3000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    assert.deepStrictEqual(result, { code: 0, signal: null });
    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.vscode', 'sn-agent-port.json')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
