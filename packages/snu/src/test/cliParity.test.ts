import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { VERSION } from '../version.js';
import { AGENT_API_VERSION } from '../types.js';

const sysId = '0123456789abcdef0123456789abcdef';

test('CLI 0.4 commands preserve file content and map to the bridge contract', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snu-cli-parity-')));
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') {
      res.end(JSON.stringify({ status: 'success', apiVersion: AGENT_API_VERSION, pid: process.pid }));
      return;
    }
    assert.equal(req.headers['x-agent-token'], 'test-agent');
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    if (request.command === 'run_background_script') {
      res.statusCode = 202;
      res.end(JSON.stringify({ id: request.id, command: request.command, status: 'error',
        code: 'E_REVIEW_PENDING', error: 'Approval required', details: { reviewId: 'review-test' } }));
    } else {
      res.end(JSON.stringify({ id: request.id, command: request.command, status: 'success',
        result: request.command === 'negotiate' ? { commands: ['negotiate'] } : { params: request.params } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const portFile = path.join(root, 'port.json');
  fs.writeFileSync(portFile, JSON.stringify({ port: (server.address() as any).port,
    token: 'test-agent', pid: process.pid, apiVersion: AGENT_API_VERSION }), { mode: 0o600 });
  const bin = path.resolve(__dirname, '../../bin/snu.js');
  const run = (args: string[], stdin = '') => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args, '--port-file', portFile, '--json'], {
      cwd: root, env: { ...process.env, CI: '1', SNU_DISABLE_UPDATE_CHECK: '1' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
  const fields = { script: 'line one\nline two\n', active: true };
  fs.writeFileSync(path.join(root, 'fields.json'), JSON.stringify(fields));

  await t.test('artifact JSON file and explicit scope', async () => {
    const result = await run(['artifact', 'create', 'sys_script_include', 'Helper', '--file', 'fields.json', '--scope', 'x_acme_app']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.at(-1).params, { table: 'sys_script_include',
      fields: { ...fields, name: 'Helper' }, scope: 'x_acme_app', await: true });
  });
  await t.test('batch fields from stdin', async () => {
    const result = await run(['record', 'update-batch', 'sp_widget', sysId], JSON.stringify(fields));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.at(-1).command, 'update_record_batch');
    assert.deepEqual(requests.at(-1).params.fields, fields);
    assert.equal(requests.at(-1).params.await, true);
  });
  await t.test('attachment file uses an absolute bridge path', async () => {
    const result = await run(['attachment', 'upload', 'incident', sysId, '--file', 'fields.json',
      '--name', 'payload.json', '--content-type', 'application/json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.at(-1).params, { table: 'incident', sys_id: sysId,
      filePath: path.join(root, 'fields.json'), fileName: 'payload.json', contentType: 'application/json' });
  });
  await t.test('review nonblocking poll preserves zero wait', async () => {
    const result = await run(['review', 'result', 'review-test', '--wait', '0']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.at(-1).params, { reviewId: 'review-test', waitSeconds: 0 });
  });
  await t.test('negotiate adds the client version', async () => {
    const result = await run(['negotiate']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).clientVersion, VERSION);
  });
  await t.test('ambiguous or malformed input never reaches the bridge', async () => {
    const before = requests.length;
    for (const args of [
      ['record', 'update-batch', 'incident', sysId, '--fields', '{}', '--file', 'fields.json'],
      ['artifact', 'create', 'sys_script_include', 'Helper', '--fields', '[]'],
      ['review', 'result', 'review-test', '--wait', 'NaN'],
    ]) {
      const result = await run(args);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).code, 'E_INVALID_PARAMS');
    }
    assert.equal(requests.length, before);
  });
  await t.test('pending review JSON retains the id for polling', async () => {
    const result = await run(['run', 'gs.print(1);']);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).code, 'E_REVIEW_PENDING');
    assert.equal(JSON.parse(result.stderr).details.reviewId, 'review-test');
  });
});
