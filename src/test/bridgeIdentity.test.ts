import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadBridgeId } from '../BridgeIdentity';

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
      { eval: true, workerData: { module: require.resolve('../BridgeIdentity'), dir } });
    worker.on('message', resolve);
    worker.on('error', reject);
  })));
  assert.match(ids[0], /^[a-f0-9]{64}$/);
  assert.strictEqual(new Set(ids).size, 1);
  assert.strictEqual(loadBridgeId(dir), ids[0]);
  assert.deepStrictEqual(fs.readdirSync(dir), ['bridge-id']);
});
