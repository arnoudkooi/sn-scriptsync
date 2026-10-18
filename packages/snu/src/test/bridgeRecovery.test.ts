import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { discoverBridge } from '../client.js';
import { inspectBridge, requestEditorBridgeLifecycle } from '../cli/daemon.js';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-editor-recovery-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'unrelated-project');
  const workspaceRoot = path.join(root, 'editor-project');
  const portFile = path.join(workspaceRoot, '.vscode', 'sn-agent-port.json');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  // Isolate descriptor lookup without touching the user's global descriptor.
  t.mock.method(require('os'), 'homedir', () => home);
  const signals: Array<string | number | undefined> = [];
  t.mock.method(process, 'kill', (_pid: number, signal?: string | number) => {
    signals.push(signal);
    assert.equal(signal, 0, 'recovery must never signal an editor process');
    return true;
  });
  const health: any = { status: 'success', apiVersion: 10, hostKind: 'vscode',
    pid: process.pid, workspaceRoot, commands: ['yield', 'restart'], startedAt: 1 };
  const calls: Array<{ url: string; token?: string; body?: any }> = [];
  let changePidOnRecheck = false;
  let stopOnYield = false;
  let probes = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const call = { url: req.url!, token: req.headers['x-agent-token'] as string | undefined, body: undefined as any };
    calls.push(call);
    if (req.url === '/api/health') {
      probes++;
      res.end(JSON.stringify({ ...health, ...(changePidOnRecheck && probes > 1 ? { pid: process.pid + 1 } : {}) }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    call.body = JSON.parse(body);
    res.statusCode = call.token === 'test-editor-token' ? 200 : 401;
    res.end(JSON.stringify({ status: res.statusCode === 200 ? 'success' : 'error' }));
    if (stopOnYield && res.statusCode === 200 && call.body.command === 'yield') setTimeout(() => server.close(), 20);
  });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const descriptor = { port, pid: process.pid, token: 'test-editor-token', apiVersion: 10, startedAt: 1 };
  const writeDescriptor = (extra: Record<string, any> = {}, target = portFile) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ ...descriptor, ...extra }));
  };
  writeDescriptor();
  return { home, cwd, portFile, port, health, calls, signals, writeDescriptor,
    options: { cwd, healthPort: port }, changePid: () => { changePidOnRecheck = true; },
    stopOnYield: () => { stopOnYield = true; } };
}

test('recovery finds an editor in another workspace and sends an authenticated graceful yield', async t => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.portFile, 'utf8');
  const status = await inspectBridge(f.options);
  assert.equal(status.running, true);
  if (!status.running) throw new Error('editor not found');
  assert.equal(status.discovery.portFilePath, f.portFile);
  assert.equal(status.discovery.isGlobal, false);
  await requestEditorBridgeLifecycle(status, 'yield');
  assert.deepEqual(f.calls.filter(call => call.body), [{
    url: '/api', token: 'test-editor-token',
    body: { id: 'snu_lifecycle_yield', command: 'yield', params: {} },
  }]);
  assert.ok(f.signals.every(signal => signal === 0));
  assert.equal(fs.readFileSync(f.portFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.home, '.sn-scriptsync', 'agent-port.json')), false);
});

test('CLI stop discovers the editor on --port and releases its listener without a port-file flag', async t => {
  const f = await fixture(t);
  f.stopOnYield();
  const preload = path.join(f.cwd, 'isolate.cjs');
  // Run the real CLI, but restrict it to the fixture even if discovery regresses.
  // Neither the user's descriptor nor their running bridge may be touched.
  fs.writeFileSync(preload, `
    require('os').homedir = () => ${JSON.stringify(f.home)};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (new URL(url).origin !== 'http://127.0.0.1:${f.port}') return Promise.reject(new Error('Unexpected test network request'));
      return originalFetch(url, init);
    };
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (signal !== 0) throw new Error('A CLI stop must not signal the editor process');
      return originalKill.call(process, pid, signal);
    };
  `);
  const bin = path.resolve(__dirname, '../../bin/snu.js');
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', preload, bin, 'stop', '--port', String(f.port), '--json'], {
      cwd: f.cwd, env: { ...process.env, SNU_DISABLE_UPDATE_CHECK: '1', CI: '1' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { stopped: true, hostKind: 'vscode', pid: process.pid });
  assert.equal(f.calls.filter(call => call.body?.command === 'yield').length, 1);
  assert.equal(result.stdout.includes('test-editor-token'), false);
});

for (const location of ['explicit', 'workspace', 'global'] as const) {
  test(`recovery preserves ${location} descriptor precedence`, async t => {
    const f = await fixture(t);
    const target = location === 'global' ? path.join(f.home, '.sn-scriptsync', 'agent-port.json')
      : path.join(f.cwd, '.vscode', 'sn-agent-port.json');
    f.writeDescriptor({}, target);
    // This listener must not be probed once an ordinary descriptor succeeds.
    const result = await discoverBridge({ ...f.options, healthPort: 1,
      ...(location === 'explicit' ? { portFile: target } : {}) });
    assert.equal(result.portFilePath, target);
    assert.equal(result.isGlobal, location === 'global');
    assert.equal(f.calls.length, 1);
  });
}

test('an invalid explicit descriptor does not fall back to a different bridge', async t => {
  const f = await fixture(t);
  await assert.rejects(discoverBridge({ ...f.options, portFile: path.join(f.cwd, 'missing.json') }),
    (error: any) => error.code === 'E_PORT_FILE_NOT_FOUND');
  assert.equal(f.calls.length, 0);
});

test('a stale global descriptor falls back to the live editor workspace', async t => {
  const f = await fixture(t);
  f.writeDescriptor({ pid: process.pid + 1 }, path.join(f.home, '.sn-scriptsync', 'agent-port.json'));
  const result = await discoverBridge(f.options);
  assert.equal(result.portFilePath, f.portFile);
});

for (const mismatch of ['port', 'pid'] as const) {
  test(`recovery refuses a workspace descriptor with a different ${mismatch}`, async t => {
    const f = await fixture(t);
    f.writeDescriptor({ [mismatch]: mismatch === 'port' ? (f.port === 65535 ? 65534 : f.port + 1) : process.pid + 1 });
    assert.deepEqual(await inspectBridge(f.options), { running: false });
    assert.equal(f.calls.length, 1, 'only the original health endpoint is probed');
    assert.deepEqual(f.signals, [], 'mismatched identity is rejected before process probing');
  });
}

test('recovery refuses a bridge whose PID changed during discovery', async t => {
  const f = await fixture(t);
  f.changePid();
  assert.deepEqual(await inspectBridge(f.options), { running: false });
  assert.ok(f.calls.every(call => call.url === '/api/health' && !call.token));
});

for (const invalid of ['missing', 'corrupt', 'no-token', 'relative-workspace', 'no-workspace', 'non-editor'] as const) {
  test(`recovery does not authorize an editor with ${invalid} discovery data`, async t => {
    const f = await fixture(t);
    if (invalid === 'missing') fs.unlinkSync(f.portFile);
    if (invalid === 'corrupt') fs.writeFileSync(f.portFile, '{');
    if (invalid === 'no-token') f.writeDescriptor({ token: '' });
    if (invalid === 'relative-workspace') f.health.workspaceRoot = 'editor-project';
    if (invalid === 'no-workspace') delete f.health.workspaceRoot;
    if (invalid === 'non-editor') f.health.hostKind = 'standalone';
    assert.deepEqual(await inspectBridge(f.options), { running: false });
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls.every(call => !call.token));
  });
}
