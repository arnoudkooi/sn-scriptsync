import test from 'node:test';
import assert from 'node:assert';
import { requestEditorBridgeLifecycle, ActiveBridgeStatus } from '../cli/daemon.js';

function editorStatus(): ActiveBridgeStatus {
  return {
    running: true,
    discovery: {
      port: 1977,
      token: 'tok',
      pid: 4242,
      apiVersion: 9,
      portFilePath: '/tmp/agent-port.json',
      isGlobal: true,
    },
    health: {
      status: 'success',
      apiVersion: 9,
      hostKind: 'vscode',
      commands: [],
      pid: 4242,
      extensionVersion: '4.9.0',
    },
  };
}

function fakeFetch(response: { ok: boolean; status: number; body: any }) {
  const seen: any[] = [];
  const impl = async (url: string, init: any) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    };
  };
  return { impl: impl as any, seen };
}

test('a yield goes to POST /api with the bridge token', async () => {
  const { impl, seen } = fakeFetch({ ok: true, status: 200, body: { status: 'success' } });

  await requestEditorBridgeLifecycle(editorStatus(), 'yield', impl);

  assert.strictEqual(seen.length, 1);
  // The editor host routes everything through /api — /api/yield is standalone-only.
  assert.strictEqual(seen[0].url, 'http://127.0.0.1:1977/api');
  assert.strictEqual(seen[0].init.method, 'POST');
  assert.strictEqual(seen[0].init.headers['X-Agent-Token'], 'tok');
  assert.strictEqual(seen[0].body.command, 'yield');
});

test('a restart sends the restart command', async () => {
  const { impl, seen } = fakeFetch({ ok: true, status: 200, body: { status: 'success' } });

  await requestEditorBridgeLifecycle(editorStatus(), 'restart', impl);

  assert.strictEqual(seen[0].body.command, 'restart');
});

test('an HTTP failure surfaces as E_STOP_FAILED rather than resolving', async () => {
  const { impl } = fakeFetch({ ok: false, status: 500, body: { status: 'error', error: 'boom' } });

  await assert.rejects(
    () => requestEditorBridgeLifecycle(editorStatus(), 'yield', impl),
    (err: any) => err.code === 'E_STOP_FAILED' && /boom/.test(err.message)
  );
});

test('a bridge that answers 200 but not success is still a failure', async () => {
  const { impl } = fakeFetch({ ok: true, status: 200, body: { status: 'error', error: 'unsupported' } });

  await assert.rejects(
    () => requestEditorBridgeLifecycle(editorStatus(), 'restart', impl),
    (err: any) => err.code === 'E_RESTART_FAILED'
  );
});

// ---------------------------------------------------------------------------
// Restart detection. Waiting for the bridge to go *unreachable* first was a
// false-negative machine: the down-state is transient, so a stop/start that
// completed between two polls was never observed and `snu restart --json`
// reported E_STOP_TIMEOUT for a restart that had already succeeded.
// ---------------------------------------------------------------------------

import { waitForBridgeRestarted } from '../cli/daemon.js';

function healthServer(sequence: Array<{ startedAt?: number; pid?: number } | null>) {
  let i = 0;
  const server = require('http').createServer((req: any, res: any) => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i++;
    if (step === null) {
      req.socket.destroy(); // mid-cycle: endpoint briefly down
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', apiVersion: 9, commands: [], ...step }));
  });
  return server;
}

function listen(server: any): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('a restart is detected when startedAt changes, even with no observed downtime', async () => {
  // The exact false negative: the bridge never appears unreachable.
  const server = healthServer([{ startedAt: 1000, pid: 42 }, { startedAt: 2000, pid: 42 }]);
  const port = await listen(server);
  try {
    const health = await waitForBridgeRestarted(port, { startedAt: 1000, pid: 42 }, { timeoutMs: 5_000 });
    assert.strictEqual(health.startedAt, 2000);
  } finally {
    server.close();
  }
});

test('a restart is detected when the PID changes', async () => {
  const server = healthServer([{ startedAt: 1000, pid: 42 }, { startedAt: 1000, pid: 77 }]);
  const port = await listen(server);
  try {
    const health = await waitForBridgeRestarted(port, { startedAt: 1000, pid: 42 }, { timeoutMs: 5_000 });
    assert.strictEqual(health.pid, 77);
  } finally {
    server.close();
  }
});

test('a brief unreachable window during the cycle is tolerated', async () => {
  const server = healthServer([{ startedAt: 1000, pid: 42 }, null, null, { startedAt: 3000, pid: 43 }]);
  const port = await listen(server);
  try {
    const health = await waitForBridgeRestarted(port, { startedAt: 1000, pid: 42 }, { timeoutMs: 8_000 });
    assert.strictEqual(health.startedAt, 3000);
  } finally {
    server.close();
  }
});

test('a bridge that never cycles is reported as a restart failure, not a stop timeout', async () => {
  const server = healthServer([{ startedAt: 1000, pid: 42 }]);
  const port = await listen(server);
  try {
    await assert.rejects(
      () => waitForBridgeRestarted(port, { startedAt: 1000, pid: 42 }, { timeoutMs: 1_000 }),
      (err: any) => err.code === 'E_RESTART_FAILED'
    );
  } finally {
    server.close();
  }
});

test('a bridge that comes back on a DIFFERENT port is still detected', async () => {
  // After a force takeover the bridge falls back to an ephemeral port because
  // the displaced process still holds 1977; the restart then moves it back.
  // Polling only the pre-restart port waited out the timeout against an
  // address nothing was serving any more.
  const oldServer = healthServer([{ startedAt: 1000, pid: 42 }]);
  const oldPort = await listen(oldServer);
  const newServer = healthServer([{ startedAt: 9000, pid: 43 }]);
  const newPort = await listen(newServer);
  try {
    const health = await waitForBridgeRestarted(
      [oldPort],
      { startedAt: 1000, pid: 42 },
      { timeoutMs: 5_000, rediscover: async () => newPort }
    );
    assert.strictEqual(health.startedAt, 9000);
    assert.strictEqual(health.pid, 43);
  } finally {
    oldServer.close();
    newServer.close();
  }
});

test('an explicitly listed alternative port is probed without rediscovery', async () => {
  const stale = healthServer([{ startedAt: 1000, pid: 42 }]);
  const stalePort = await listen(stale);
  const fresh = healthServer([{ startedAt: 7000, pid: 44 }]);
  const freshPort = await listen(fresh);
  try {
    const health = await waitForBridgeRestarted(
      [stalePort, freshPort],
      { startedAt: 1000, pid: 42 },
      { timeoutMs: 5_000 }
    );
    assert.strictEqual(health.pid, 44);
  } finally {
    stale.close();
    fresh.close();
  }
});

test('the failure message names every port that was tried', async () => {
  const server = healthServer([{ startedAt: 1000, pid: 42 }]);
  const port = await listen(server);
  try {
    await assert.rejects(
      () => waitForBridgeRestarted([port, 65123], { startedAt: 1000, pid: 42 }, { timeoutMs: 800 }),
      (err: any) => err.code === 'E_RESTART_FAILED' && err.message.includes(String(port)) && err.message.includes('65123')
    );
  } finally {
    server.close();
  }
});
