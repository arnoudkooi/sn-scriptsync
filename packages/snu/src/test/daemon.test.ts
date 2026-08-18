import test from 'node:test';
import assert from 'node:assert';
import {
  assertStandaloneBridge,
  requestStandaloneYield,
  waitForBridgeExit,
  BridgeStatus,
} from '../cli/daemon.js';

function standaloneStatus(): BridgeStatus {
  return {
    running: true,
    discovery: {
      port: 1977,
      token: 'test-token',
      pid: 1234,
      apiVersion: 8,
      portFilePath: '/tmp/agent-port.json',
      isGlobal: true,
    },
    health: {
      status: 'success',
      apiVersion: 8,
      hostKind: 'standalone',
      commands: [],
      pid: 1234,
    },
  };
}

test('Daemon lifecycle: refuses to manage a VS Code bridge', () => {
  const status = standaloneStatus();
  if (!status.running) throw new Error('invalid fixture');
  status.health.hostKind = 'vscode';
  assert.throws(
    () => assertStandaloneBridge(status),
    (err: any) => err?.code === 'E_NOT_STANDALONE'
  );
});

test('Daemon lifecycle: refuses a PID mismatch', () => {
  const status = standaloneStatus();
  if (!status.running) throw new Error('invalid fixture');
  status.health.pid = 9999;
  assert.throws(
    () => assertStandaloneBridge(status),
    (err: any) => err?.code === 'E_STALE_PORT_FILE'
  );
});

test('Daemon lifecycle: sends authenticated graceful yield', async () => {
  let called = false;
  await requestStandaloneYield(standaloneStatus(), async (url, init) => {
    called = true;
    assert.strictEqual(url, 'http://127.0.0.1:1977/api/yield');
    assert.strictEqual(init.method, 'POST');
    assert.strictEqual(init.headers['X-Agent-Token'], 'test-token');
    assert.strictEqual(JSON.parse(init.body).command, 'yield');
    return {
      ok: true,
      status: 200,
      async json() {
        return { status: 'success' };
      },
    };
  });
  assert.strictEqual(called, true);
});

test('Daemon lifecycle: waits for the managed PID to exit', async () => {
  let checks = 0;
  await waitForBridgeExit(1234, 500, () => ++checks < 3);
  assert.strictEqual(checks, 3);
});
