import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { loadBridgeId } from '../server/bridgeIdentity.js';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';

/**
 * The helper tab refreshes session tokens on its own after a reconnect, but only
 * for a bridge the user already handed a token to. It recognises that bridge by
 * the id in the hello, so the id has to survive restarts and stay private.
 */

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'snu-bridgeid-')); }

test('bridge id: created once, then reused across restarts', () => {
  const dir = path.join(tmp(), 'nested', '.sn-scriptsync');
  const first = loadBridgeId(dir);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.strictEqual(loadBridgeId(dir), first);
});

test('bridge id: the file is private to the user', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  loadBridgeId(dir);
  assert.strictEqual(fs.statSync(path.join(dir, 'bridge-id')).mode & 0o777, 0o600);
});

test('bridge id: unusable content fails closed without overwriting it', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'bridge-id'), 'not-an-id');
  const id = loadBridgeId(dir);
  assert.strictEqual(id, '');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'bridge-id'), 'utf8'), 'not-an-id');
});

test('bridge id: an unwritable location yields no identity instead of throwing', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  assert.strictEqual(loadBridgeId(path.join(blocker, 'sub')), '');
});

async function openHelper(port: number, origin?: string): Promise<{ ws: WebSocket; hello: Promise<any>; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : undefined);
  const hello = new Promise<any>((resolve) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.action === 'hostHello') resolve(msg);
  }));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  return { ws, hello, closed };
}

test('hello: names the bridge and advertises session refresh', async () => {
  const id = 'a'.repeat(64);
  const bridge = new StandaloneWsBridge(0, new PendingRegistry(), 30_000, id);
  const port = await bridge.start();
  try {
    const { ws, hello } = await openHelper(port, 'chrome-extension://abcdefghijklmnop');
    const msg = await hello;
    assert.strictEqual(msg.bridgeId, id);
    assert.strictEqual(msg.features.sessionRefresh, 1);
    assert.strictEqual(msg.hostKind, 'standalone');
    ws.close();
  } finally {
    await bridge.close();
  }
});

for (const origin of ['https://evil.example', 'http://localhost', 'null', 'file://']) {
test(`hello: origin ${origin} is refused and never becomes the helper`, async () => {
  const bridge = new StandaloneWsBridge(0, new PendingRegistry(), 30_000, 'b'.repeat(64));
  const port = await bridge.start();
  try {
    const { closed } = await openHelper(port, origin);
    assert.strictEqual(await closed, 1008);
    assert.strictEqual(bridge.hasBrowserClient(), false);
  } finally {
    await bridge.close();
  }
});

}

for (const origin of [undefined, 'moz-extension://test-id', 'safari-web-extension://test-id']) {
  test(`hello: legitimate client ${origin} is accepted`, async () => {
    const bridge = new StandaloneWsBridge(0, new PendingRegistry(), 30_000, 'd'.repeat(64));
    const port = await bridge.start();
    try {
      const { ws, hello } = await openHelper(port, origin);
      assert.strictEqual((await hello).bridgeId, 'd'.repeat(64));
      ws.close();
    } finally { await bridge.close(); }
  });
}

test('a token re-sent after a reconnect restores the live instance', async () => {
  const bridge = new StandaloneWsBridge(0, new PendingRegistry(), 30_000, 'c'.repeat(64));
  const port = await bridge.start();
  const token = { instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'tok' }, silentRefresh: true };
  try {
    const first = await openHelper(port);
    first.ws.send(JSON.stringify(token));
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(bridge.getLiveInstances().length, 1);

    first.ws.close();
    await first.closed;
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(bridge.getLiveInstances().length, 0, 'a helper disconnect still clears sessions');

    const second = await openHelper(port);
    second.ws.send(JSON.stringify(token));
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(bridge.getLiveInstances()[0]?.url, 'https://dev123.service-now.com');
    second.ws.close();
  } finally {
    await bridge.close();
  }
});

test('bridge id: an existing identity is made private', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const file = path.join(dir, 'bridge-id');
  fs.writeFileSync(file, 'e'.repeat(64), { mode: 0o644 });
  assert.strictEqual(loadBridgeId(dir), 'e'.repeat(64));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('bridge id: symlinks are not followed', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'f'.repeat(64));
  fs.symlinkSync(target, path.join(dir, 'bridge-id'));
  assert.strictEqual(loadBridgeId(dir), '');
});

test('bridge id: simultaneous hosts use the same complete identity', async () => {
  const dir = tmp();
  const { Worker } = await import('node:worker_threads');
  const ids = await Promise.all(Array.from({ length: 12 }, () => new Promise<string>((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      parentPort.postMessage(require(workerData.module).loadBridgeId(workerData.dir));`,
      { eval: true, workerData: { module: require.resolve('../server/bridgeIdentity.js'), dir } });
    worker.on('message', resolve);
    worker.on('error', reject);
  })));
  assert.match(ids[0], /^[a-f0-9]{64}$/);
  assert.strictEqual(new Set(ids).size, 1);
  assert.strictEqual(loadBridgeId(dir), ids[0]);
  assert.deepStrictEqual(fs.readdirSync(dir), ['bridge-id']);
});

test('inspect: reports the state without creating, fixing or revealing anything', { skip: process.platform === 'win32' }, async () => {
  const { inspectBridgeId } = await import('../server/bridgeIdentity.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-bridgeid-inspect-'));
  assert.deepStrictEqual(inspectBridgeId(dir), { status: 'missing', private: null });
  assert.strictEqual(fs.existsSync(path.join(dir, 'bridge-id')), false, 'inspection must not create the file');

  const id = loadBridgeId(dir);
  const ok = inspectBridgeId(dir);
  assert.deepStrictEqual(ok, { status: 'ok', private: true });
  assert.ok(!JSON.stringify(ok).includes(id));

  fs.chmodSync(path.join(dir, 'bridge-id'), 0o644);
  assert.deepStrictEqual(inspectBridgeId(dir), { status: 'ok', private: false });
  assert.strictEqual(fs.statSync(path.join(dir, 'bridge-id')).mode & 0o777, 0o644, 'inspection must not change the mode');

  fs.writeFileSync(path.join(dir, 'bridge-id'), 'garbage');
  assert.strictEqual(inspectBridgeId(dir).status, 'invalid');
});
