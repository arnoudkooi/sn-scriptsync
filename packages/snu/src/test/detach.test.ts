import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import {
  DETACHED_CHILD_ENV,
  planDetachedSpawn,
  spawnDetachedBridge,
  waitForDetachedBridge,
  isDetachedChild,
  mcpBridgeMode,
  isPidAlive,
  snuBinPath,
  servingGuard,
  SpawnImpl,
} from '../cli/detach.js';
import { requestStandaloneYield, waitForBridgeExit } from '../cli/daemon.js';
import { checkHealth } from '../client.js';
import { classifyListener, reclaimPort } from '../cli/portReclaim.js';
import { unknownLifecycleOptionError } from '../cli/index.js';
import { HealthResponse } from '../types.js';

const health = (pid: number): HealthResponse => ({
  status: 'success',
  apiVersion: 8,
  hostKind: 'standalone',
  commands: [],
  pid,
});

test('Detach: spawn plan is detached, hidden on Windows, and never inherits stdio', () => {
  const plan = planDetachedSpawn(
    { cwd: '/work', httpPort: 1979, wsPort: 1980, execPath: '/usr/bin/node', binPath: '/pkg/bin/snu.js', env: { PATH: '/bin' } },
    7
  );
  assert.strictEqual(plan.command, '/usr/bin/node');
  assert.deepStrictEqual(plan.args, ['/pkg/bin/snu.js', 'serve', '--json', '--port', '1979', '--ws', '1980']);
  assert.strictEqual(plan.options.detached, true);
  assert.strictEqual(plan.options.windowsHide, true);
  assert.strictEqual(plan.options.cwd, '/work');
  assert.deepStrictEqual(plan.options.stdio, ['ignore', 7, 7]);
  assert.strictEqual(plan.options.env?.[DETACHED_CHILD_ENV], '1');
  assert.strictEqual(plan.options.env?.PATH, '/bin');
});

test('Detach: the child command line is recognised as an snu bridge, so snu stop can reclaim it', () => {
  const plan = planDetachedSpawn({ cwd: '/work', execPath: '/usr/local/bin/node' }, 'ignore');
  assert.strictEqual(classifyListener([plan.command, ...plan.args].join(' ')), 'snu');
  assert.strictEqual(classifyListener('C:\\Program Files\\nodejs\\node.exe C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@snutils\\snu\\bin\\snu.js serve --json'), 'snu');
});

/** A fake ChildProcess that reports 'spawn' or 'error' asynchronously, like the real one. */
function fakeChild(pid: number | undefined, outcome: 'spawn' | Error, onUnref: () => void = () => {}) {
  const child = Object.assign(new EventEmitter(), { pid, unref: onUnref });
  setImmediate(() => (outcome === 'spawn' ? child.emit('spawn') : child.emit('error', outcome)));
  return child;
}

test('Detach: spawnDetachedBridge unrefs the child and closes its own log descriptor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-detach-'));
  const logFile = path.join(dir, 'nested', 'bridge.log');
  let unrefd = false;
  let seenFd: unknown;
  const spawnImpl: SpawnImpl = (_cmd, _args, options) => {
    seenFd = (options.stdio as unknown[])[1];
    return fakeChild(4242, 'spawn', () => { unrefd = true; });
  };
  try {
    const spawned = await spawnDetachedBridge({ cwd: dir }, { spawnImpl, logFile });
    assert.strictEqual(spawned.pid, 4242);
    assert.strictEqual(spawned.logFile, logFile);
    assert.strictEqual(unrefd, true);
    assert.strictEqual(typeof seenFd, 'number');
    assert.ok(fs.existsSync(logFile));
    assert.throws(() => fs.fstatSync(seenFd as number), /EBADF/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Detach: an asynchronous spawn error rejects instead of escaping as an uncaught exception', async () => {
  const spawnImpl: SpawnImpl = () => fakeChild(undefined, Object.assign(new Error('spawn /nope ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(
    spawnDetachedBridge({ cwd: os.tmpdir() }, { spawnImpl, logFile: null }),
    (err: any) => err?.code === 'E_SPAWN_FAILED' && /ENOENT/.test(err.message)
  );
});

test('Detach: a real spawn of a missing executable is caught, and the process survives', async () => {
  // Without a lasting 'error' listener this is the uncaught exception that
  // took down `snu --mcp` instead of letting it fall back to in-process.
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    await assert.rejects(
      spawnDetachedBridge(
        { cwd: os.tmpdir(), execPath: path.join(os.tmpdir(), 'snu-no-such-node-binary') },
        { spawnImpl: spawn as unknown as SpawnImpl, logFile: null }
      ),
      (err: any) => err?.code === 'E_SPAWN_FAILED'
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(uncaught, []);
  } finally {
    process.removeListener('uncaughtException', onUncaught);
  }
});

test('Detach: a spawn that yields no PID is an error, not a silent success', async () => {
  const spawnImpl: SpawnImpl = () => fakeChild(undefined, 'spawn');
  await assert.rejects(
    spawnDetachedBridge({ cwd: os.tmpdir() }, { spawnImpl, logFile: null }),
    (err: any) => err?.code === 'E_SPAWN_FAILED'
  );
});

test('Detach: servingGuard spares a bridge that only answers after a short delay', async () => {
  let calls = 0;
  const guard = servingGuard(async () => (++calls >= 4 ? health(1) : undefined), { graceMs: 1_000, intervalMs: 5 });
  assert.strictEqual(await guard(), true);
  const dead = servingGuard(async () => undefined, { graceMs: 30, intervalMs: 5 });
  assert.strictEqual(await dead(), false);
});

test('Detach: reclaimPort never signals a listener the serving guard vouches for', async () => {
  let terminated = false;
  const result = await reclaimPort(1978, {
    findImpl: async () => ({ pid: 77, command: 'node /x/@snutils/snu/bin/snu.js serve --json' }),
    terminateImpl: async () => { terminated = true; return true; },
    isServing: async () => true,
  });
  assert.strictEqual(result.status, 'serving');
  assert.strictEqual(terminated, false);
});

test('Detach: waits until the spawned child answers', async () => {
  let calls = 0;
  const ready = await waitForDetachedBridge(
    100,
    { probe: async () => (++calls >= 3 ? health(100) : undefined), isAlive: () => true },
    { intervalMs: 1 }
  );
  assert.strictEqual(ready.ownChild, true);
  assert.strictEqual(calls, 3);
});

test('Detach: a racing session that bound first is attached to, not treated as failure', async () => {
  const ready = await waitForDetachedBridge(
    100,
    { probe: async () => health(200), isAlive: () => false },
    { intervalMs: 1 }
  );
  assert.strictEqual(ready.ownChild, false);
  assert.strictEqual(ready.health.pid, 200);
});

test('Detach: a child that died with nothing answering fails fast', async () => {
  const started = Date.now();
  await assert.rejects(
    waitForDetachedBridge(100, { probe: async () => undefined, isAlive: () => false }, { timeoutMs: 5_000, intervalMs: 1 }),
    (err: any) => err?.code === 'E_SPAWN_FAILED' && /exited/.test(err.message)
  );
  assert.ok(Date.now() - started < 1_000);
});

test('Detach: a child that never answers times out', async () => {
  await assert.rejects(
    waitForDetachedBridge(100, { probe: async () => undefined, isAlive: () => true }, { timeoutMs: 30, intervalMs: 5 }),
    (err: any) => err?.code === 'E_SPAWN_FAILED' && /did not answer/.test(err.message)
  );
});

test('Detach: environment switches', () => {
  assert.strictEqual(isDetachedChild({ [DETACHED_CHILD_ENV]: '1' }), true);
  assert.strictEqual(isDetachedChild({}), false);
});

test('Detach: MCP bridge mode is detached on macOS/Linux, in-process on Windows, and an explicit value wins', () => {
  assert.strictEqual(mcpBridgeMode({}, 'darwin'), 'detached');
  assert.strictEqual(mcpBridgeMode({}, 'linux'), 'detached');
  assert.strictEqual(mcpBridgeMode({}, 'win32'), 'inprocess');
  assert.strictEqual(mcpBridgeMode({ SNU_MCP_BRIDGE: 'detached' }, 'win32'), 'detached');
  assert.strictEqual(mcpBridgeMode({ SNU_MCP_BRIDGE: 'InProcess' }, 'darwin'), 'inprocess');
  assert.strictEqual(mcpBridgeMode({ SNU_MCP_BRIDGE: ' inprocess ' }, 'linux'), 'inprocess');
  assert.strictEqual(mcpBridgeMode({ SNU_MCP_BRIDGE: 'bogus' }, 'win32'), 'inprocess');
  assert.strictEqual(mcpBridgeMode({ SNU_MCP_BRIDGE: 'bogus' }, 'linux'), 'detached');
});

test('Detach: --detach is a known serve/restart option only', () => {
  assert.strictEqual(unknownLifecycleOptionError('serve', ['--detach']), null);
  assert.strictEqual(unknownLifecycleOptionError('restart', ['--detach', '--force']), null);
  assert.match(unknownLifecycleOptionError('stop', ['--detach'])!, /--detach/);
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

test('Detach: a real detached bridge runs as its own process and stops cleanly via yield', { timeout: 30_000 }, async () => {
  assert.ok(fs.existsSync(snuBinPath()), `expected CLI entry at ${snuBinPath()}`);
  // Isolated home and workspace: the child must not touch the user's real
  // ~/.sn-scriptsync descriptor or a bridge on the default ports.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-detach-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-detach-cwd-'));
  const httpPort = await freePort();
  const wsPort = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const logFile = path.join(home, 'bridge.log');

  const spawned = await spawnDetachedBridge({ cwd, httpPort, wsPort, env }, { logFile });
  try {
    const ready = await waitForDetachedBridge(spawned.pid, {
      probe: async () => {
        try { return await checkHealth(httpPort); } catch { return undefined; }
      },
      isAlive: isPidAlive,
    });
    assert.strictEqual(ready.ownChild, true);
    assert.strictEqual(ready.health.hostKind, 'standalone');
    assert.notStrictEqual(ready.health.pid, process.pid);

    // Workspace descriptor carries the token the stop path needs.
    const descriptor = JSON.parse(fs.readFileSync(path.join(cwd, '.vscode', 'sn-agent-port.json'), 'utf8'));
    assert.strictEqual(descriptor.pid, spawned.pid);
    assert.strictEqual(descriptor.port, httpPort);
    assert.ok(fs.existsSync(path.join(home, '.sn-scriptsync', 'agent-port.json')));

    await requestStandaloneYield({
      running: true,
      discovery: { port: httpPort, token: descriptor.token, pid: spawned.pid, apiVersion: 8, portFilePath: '', isGlobal: false },
      health: ready.health,
    });
    await waitForBridgeExit(spawned.pid, 8_000);
    assert.strictEqual(fs.existsSync(path.join(cwd, '.vscode', 'sn-agent-port.json')), false);
  } finally {
    if (isPidAlive(spawned.pid)) {
      try { process.kill(spawned.pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Detach: two sessions spawning at once leave exactly one bridge, the loser exits', { timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-detach-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-detach-cwd-'));
  const httpPort = await freePort();
  const wsPort = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const probe = async () => {
    try { return await checkHealth(httpPort); } catch { return undefined; }
  };

  const a = await spawnDetachedBridge({ cwd, httpPort, wsPort, env }, { logFile: path.join(home, 'a.log') });
  const b = await spawnDetachedBridge({ cwd, httpPort, wsPort, env }, { logFile: path.join(home, 'b.log') });
  try {
    const [ra, rb] = await Promise.all([
      waitForDetachedBridge(a.pid, { probe, isAlive: isPidAlive }),
      waitForDetachedBridge(b.pid, { probe, isAlive: isPidAlive }),
    ]);
    assert.strictEqual(ra.health.pid, rb.health.pid, 'both sessions attach to the same bridge');
    const winner = ra.health.pid;
    const loser = winner === a.pid ? b.pid : a.pid;
    await waitForBridgeExit(loser, 8_000);
    assert.strictEqual(isPidAlive(winner), true, 'the winning bridge was not displaced');
    assert.strictEqual((await probe())?.pid, winner);
  } finally {
    for (const pid of [a.pid, b.pid]) {
      if (isPidAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Detach: a parent that found nothing does not stop a bridge another session started meanwhile', { timeout: 30_000 }, async () => {
  // The race the child-side skip cannot cover: the parent's discovery came up
  // empty, then another session's bridge bound the ports before the parent's
  // reclaim ran. Reproduced end to end through the real `snu serve --detach`
  // parent path: the descriptors are removed so discovery misses the bridge,
  // and the parent must leave it running rather than reclaim its ports.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-detach-home-'));
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-detach-cwd-'));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-detach-cwd-'));
  const httpPort = await freePort();
  const wsPort = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const probe = async () => {
    try { return await checkHealth(httpPort); } catch { return undefined; }
  };

  const a = await spawnDetachedBridge({ cwd: cwdA, httpPort, wsPort, env }, { logFile: path.join(home, 'a.log') });
  let parentOut = '';
  try {
    await waitForDetachedBridge(a.pid, { probe, isAlive: isPidAlive });
    fs.rmSync(path.join(home, '.sn-scriptsync', 'agent-port.json'), { force: true });
    fs.rmSync(path.join(cwdA, '.vscode', 'sn-agent-port.json'), { force: true });

    const parent = spawn(process.execPath, [snuBinPath(), 'serve', '--detach', '--json', '--port', String(httpPort), '--ws', String(wsPort)], {
      cwd: cwdB,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    parent.stdout.on('data', (d) => { parentOut += d; });
    parent.stderr.on('data', (d) => { parentOut += d; });
    const code = await new Promise<number | null>((resolve) => parent.on('exit', resolve));

    assert.strictEqual(code, 0, parentOut);
    assert.strictEqual(isPidAlive(a.pid), true, `the healthy bridge was stopped:\n${parentOut}`);
    assert.strictEqual((await probe())?.pid, a.pid);
    assert.match(parentOut, /"alreadyRunning": true/);
  } finally {
    if (isPidAlive(a.pid)) {
      try { process.kill(a.pid, 'SIGKILL'); } catch {}
    }
    for (const dir of [home, cwdA, cwdB]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
