import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { AGENT_API_VERSION } from '../types.js';

test('CLI errors drain output and exit naturally with status 1 (#168)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-cli-exit-'));
  const marker = path.join(root, 'before-exit');
  const preload = path.join(root, 'before-exit.cjs');
  const replyFile = path.join(root, 'reply.json');
  const requestsFile = path.join(root, 'requests.jsonl');
  // beforeExit is skipped by process.exit(), making the regression detectable
  // on every platform even when the Windows libuv assertion does not occur.
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    process.once('beforeExit', code => {
      fs.writeFileSync(${JSON.stringify(marker)}, String(code));
    });
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(url).origin, 'http://127.0.0.1:1977');
      if (new URL(url).pathname === '/api/health') {
        return Response.json({ status: 'success', apiVersion: ${AGENT_API_VERSION}, pid: ${process.pid} });
      }
      assert.equal(new URL(url).pathname, '/api');
      assert.equal(init.headers['X-Agent-Token'], 'test-agent');
      const request = JSON.parse(init.body);
      assert.equal(request.command, 'update_record');
      fs.appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(request) + '\\n');
      const reply = JSON.parse(fs.readFileSync(${JSON.stringify(replyFile)}, 'utf8'));
      return Response.json({ id: request.id, command: request.command, ...reply.body }, { status: reply.status });
    };
  `);
  const details = { writeAcknowledged: true, verified: false, reason: 'field_unreadable' };
  let errorMessage = 'Persistence verification failed';
  let succeed = false;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const portFile = path.join(root, 'port.json');
  fs.writeFileSync(portFile, JSON.stringify({ port: 1977,
    token: 'test-agent', pid: process.pid, apiVersion: AGENT_API_VERSION }), { mode: 0o600 });
  const bin = path.resolve(__dirname, '../../bin/snu.js');
  const run = async (args: string[], expectedCode = 1, executable = bin, preloadPath = preload) => {
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(requestsFile, '');
    fs.writeFileSync(replyFile, JSON.stringify({ status: succeed ? 200 : 422,
      body: succeed ? { status: 'success', result: { updated: true } }
        : { status: 'error', code: 'E_VERIFY_FAILED', error: errorMessage, details } }));
    const result = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', preloadPath, executable, ...args, '--port-file', portFile], {
        cwd: root, env: { ...process.env, CI: '1', SNU_DISABLE_UPDATE_CHECK: '1' },
        timeout: 10_000,
      });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
      child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(result.signal, null, 'CLI must terminate without a signal or timeout');
    assert.equal(result.code, expectedCode);
    assert.ok(fs.existsSync(marker), 'CLI must reach beforeExit instead of forcing process.exit()');
    assert.equal(fs.readFileSync(marker, 'utf8'), String(expectedCode));
    return result;
  };
  const update = ['-i', 'test-instance', 'record', 'update', 'incident',
    '0123456789abcdef0123456789abcdef', 'u_snu_verify_probe', '--value', 'x'];

  for (const large of [false, true]) {
    await t.test(`verify failure preserves complete JSON (${large ? 'large' : 'small'} response)`, async () => {
      errorMessage = large ? 'Verification failed: ' + 'x'.repeat(512 * 1024) : 'Persistence verification failed';
      const result = await run(['--json', ...update]);
      assert.equal(result.stdout, '');
      assert.deepEqual(JSON.parse(result.stderr), { status: 'error', error: errorMessage,
        code: 'E_VERIFY_FAILED', status_code: 422, details });
      assert.equal(fs.readFileSync(requestsFile, 'utf8').trim().split('\n').length, 1,
        'a failed verification must not retry the write');
    });
  }
  await t.test('human-readable bridge error exits naturally', async () => {
    errorMessage = 'Persistence verification failed';
    const result = await run(update);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Persistence verification failed/);
    assert.match(result.stderr, /E_VERIFY_FAILED/);
  });
  await t.test('successful bridge command still exits with status 0', async () => {
    succeed = true;
    const result = await run(['--json', ...update], 0);
    assert.deepEqual(JSON.parse(result.stdout), { updated: true });
    assert.equal(result.stderr, '');
  });
  await t.test('lifecycle validation error exits without starting a bridge', async () => {
    const result = await run(['--json', 'serve', '--port', 'invalid']);
    assert.equal(JSON.parse(result.stderr).code, 'E_INVALID_PARAMS');
  });
  await t.test('partial standalone startup closes its listener before exiting', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close(err => err ? reject(err) : resolve()));
    const startupPreload = path.join(root, 'startup.cjs');
    fs.writeFileSync(startupPreload, `
      const fs = require('node:fs');
      process.once('beforeExit', code => {
        fs.writeFileSync(${JSON.stringify(marker)}, String(code));
      });
      // Isolate discovery from any bridge running on the developer's machine.
      globalThis.fetch = async () => { throw new Error('No bridge available'); };
    `);
    // Both ports are initially free. WebSocket binds first, then HTTP fails
    // on the same port, leaving a real listener that must be closed.
    const result = await run(['--json', 'serve', '--port', String(port), '--ws', String(port)],
      1, bin, startupPreload);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'EADDRINUSE');
  });
  await t.test('fatal launcher error also exits naturally', async () => {
    // Copy the real launcher without its dist module to exercise its import
    // rejection handler without depending on an unrelated CLI parsing error.
    const brokenBin = path.join(root, 'incomplete-install', 'bin', 'snu.js');
    fs.mkdirSync(path.dirname(brokenBin), { recursive: true });
    fs.copyFileSync(bin, brokenBin);
    const result = await run([], 1, brokenBin);
    assert.match(result.stderr, /\[snu\] Fatal error:/);
  });
});
