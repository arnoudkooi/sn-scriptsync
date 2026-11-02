import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { ScriptSyncClient, ScriptSyncClientError } from '../client.js';
import { AgentRequest } from '../types.js';

const read = { command: 'check_connection', params: {} };
const write = { command: 'create_record', params: { table: 'incident', fields: { short_description: 'Once' } }, instance: 'dev123' };

function rejectToken(res: http.ServerResponse) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', code: 'E_UNAUTHORIZED', error: 'Invalid or missing X-Agent-Token' }));
}

async function fixture(t: TestContext, location: 'explicit' | 'workspace' | 'global' = 'explicit') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-client-recovery-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  t.mock.method(require('os'), 'homedir', () => home);
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.join(' ')); });
  const servers: http.Server[] = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const startBridge = async (token = 'old-agent-token') => {
    const state = {
      token,
      healthChecks: 0,
      calls: [] as Array<{ token: string | undefined; body: AgentRequest }>,
      dispatched: [] as AgentRequest[],
      onRejected: undefined as ((res: http.ServerResponse) => void) | undefined,
      onCommand: undefined as ((res: http.ServerResponse, body: AgentRequest) => void) | undefined,
    };
    const server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/health') {
        state.healthChecks++;
        res.end(JSON.stringify({ status: 'success', apiVersion: 12, pid: process.pid, commands: [] }));
        return;
      }
      assert.equal(req.url, '/api');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as AgentRequest;
      const token = req.headers['x-agent-token'] as string | undefined;
      state.calls.push({ token, body });
      if (token !== state.token) {
        (state.onRejected || rejectToken)(res);
        return;
      }
      state.dispatched.push(body);
      if (state.onCommand) {
        state.onCommand(res, body);
        return;
      }
      res.end(JSON.stringify({ id: body.id, command: body.command, status: 'success', result: { connected: true } }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return { state, server, port };
  };
  const portFile = location === 'global' ? path.join(home, '.sn-scriptsync', 'agent-port.json')
    : location === 'workspace' ? path.join(cwd, '.vscode', 'sn-agent-port.json')
    : path.join(root, 'explicit.json');
  const writeDescriptor = (bridge: Awaited<ReturnType<typeof startBridge>>, extra = {}) => {
    fs.mkdirSync(path.dirname(portFile), { recursive: true });
    fs.writeFileSync(portFile, JSON.stringify({ port: bridge.port, token: bridge.state.token, pid: process.pid, apiVersion: 12, ...extra }));
  };
  const bridge = await startBridge();
  writeDescriptor(bridge);
  const client = new ScriptSyncClient({ cwd, ...(location === 'explicit' ? { portFile } : {}) });
  return { client, bridge, portFile, writeDescriptor, startBridge, logs };
}

for (const location of ['explicit', 'workspace', 'global'] as const) {
  test(`client recovers a replaced ${location} token and caches the refreshed discovery`, async t => {
    const f = await fixture(t, location);
    await f.client.execute(read);
    f.bridge.state.token = 'replacement-agent-token';
    f.writeDescriptor(f.bridge);
    assert.deepEqual((await f.client.execute(write)).result, { connected: true });
    await f.client.execute(read);
    assert.deepEqual(f.bridge.state.calls.map(call => call.token), [
      'old-agent-token', 'old-agent-token', 'replacement-agent-token', 'replacement-agent-token',
    ]);
    const [, rejected, retried] = f.bridge.state.calls;
    assert.deepEqual(retried.body, rejected.body, 'retry preserves request ID, params and instance');
    assert.equal(f.bridge.state.dispatched.filter(body => body.command === write.command).length, 1);
    assert.equal(f.bridge.state.healthChecks, 2);
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /cached agent token.*retrying once/);
    assert.ok(f.logs.every(log => !log.includes('old-agent-token') && !log.includes('replacement-agent-token')));
  });
}

test('client rediscovers a different port after a refused connection', async t => {
  const f = await fixture(t);
  await f.client.getDiscovery();
  const replacement = await f.startBridge('replacement-agent-token');
  f.bridge.server.closeAllConnections();
  await new Promise<void>(resolve => f.bridge.server.close(() => resolve()));
  f.writeDescriptor(replacement);
  await f.client.execute(write);
  assert.equal(f.bridge.state.calls.length, 0);
  assert.equal(replacement.state.dispatched.length, 1);
  assert.equal((await f.client.getDiscovery()).port, replacement.port);
  assert.match(f.logs[0], /connection was refused/);
});

test('client retries a rejected token only once and can recover on a later call', async t => {
  const f = await fixture(t);
  await f.client.getDiscovery();
  f.bridge.state.token = 'replacement-agent-token';
  // Descriptor still contains the old token during both attempts.
  await assert.rejects(f.client.execute(write), { code: 'E_UNAUTHORIZED', status: 401 });
  assert.equal(f.bridge.state.calls.length, 2);
  assert.equal(f.bridge.state.dispatched.length, 0);
  f.writeDescriptor(f.bridge);
  await f.client.execute(write);
  assert.equal(f.bridge.state.calls.length, 3, 'failed retry must not leave old credentials cached');
  assert.equal(f.bridge.state.healthChecks, 3);
});

test('failed rediscovery preserves explicit descriptor validation and does not poison later calls', async t => {
  const f = await fixture(t);
  await f.client.getDiscovery();
  f.bridge.state.token = 'replacement-agent-token';
  f.writeDescriptor(f.bridge, { pid: process.pid + 1 });
  await assert.rejects(f.client.execute(read), (error: any) => error instanceof ScriptSyncClientError && error.code === 'E_STALE_PORT_FILE');
  assert.equal(f.bridge.state.calls.length, 1, 'unvalidated credentials must not be used');
  f.writeDescriptor(f.bridge);
  await f.client.execute(read);
  assert.equal(f.bridge.state.calls.length, 2);
});

test('concurrent calls share discovery and late old-token failures keep the refreshed cache', async t => {
  const f = await fixture(t);
  await Promise.all([f.client.getDiscovery(), f.client.getDiscovery(), f.client.getDiscovery()]);
  assert.equal(f.bridge.state.healthChecks, 1);
  f.bridge.state.token = 'replacement-agent-token';
  f.writeDescriptor(f.bridge);
  const rejected: http.ServerResponse[] = [];
  let bothArrived!: () => void;
  const ready = new Promise<void>(resolve => { bothArrived = resolve; });
  f.bridge.state.onRejected = res => {
    rejected.push(res);
    if (rejected.length === 2) bothArrived();
  };
  const first = f.client.execute(read);
  const second = f.client.execute(read);
  await ready;
  rejectToken(rejected[0]);
  await Promise.race([first, second]);
  rejectToken(rejected[1]);
  await Promise.all([first, second]);
  assert.equal(f.bridge.state.healthChecks, 2, 'late rejection must reuse the newer discovery');
  assert.equal(f.bridge.state.dispatched.length, 2);
});

test('a dropped response is never replayed, but the next call discovers the new bridge', async t => {
  const f = await fixture(t);
  const replacement = await f.startBridge('replacement-agent-token');
  f.bridge.state.onCommand = res => {
    f.writeDescriptor(replacement);
    res.destroy(); // The command ran; only its response was lost.
  };
  await assert.rejects(f.client.execute(write), { code: 'E_NETWORK_ERROR' });
  assert.equal(f.bridge.state.dispatched.length, 1);
  assert.equal(replacement.state.calls.length, 0, 'ambiguous writes must not be replayed');
  await f.client.execute(read);
  assert.equal(replacement.state.calls.length, 1);
  assert.equal((await f.client.getDiscovery()).token, 'replacement-agent-token');
});

for (const failure of [
  { status: 401, code: 'E_UNAUTHORIZED', error: 'ServiceNow rejected the background script', details: { notStarted: false } },
  { status: 403, code: 'E_SECURITY', error: 'Permission denied' },
  { status: 500, code: 'E_COMMAND_FAILED', error: 'Command failed' },
  { status: 422, code: 'E_VERIFY_FAILED', error: 'Persistence verification failed', details: { writeAcknowledged: true, verified: false, reason: 'value_mismatch' } },
  { status: 202, code: 'E_REVIEW_PENDING', error: 'Approval required', details: { reviewId: 'review-1' } },
  { status: 504, code: 'E_TIMEOUT', error: 'Helper timed out', details: { retrySafe: false } },
]) {
  test(`client preserves ${failure.code} from a dispatched command without retry`, async t => {
    const f = await fixture(t);
    f.bridge.state.onCommand = (res, body) => {
      res.statusCode = failure.status;
      res.end(JSON.stringify({ ...failure, status: 'error', id: body.id, command: body.command }));
    };
    await assert.rejects(f.client.execute(write), (error: any) => {
      assert.equal(error.code, failure.code);
      assert.equal(error.status, failure.status);
      assert.deepEqual(error.details, failure.details);
      return true;
    });
    await f.client.getDiscovery();
    assert.equal(f.bridge.state.calls.length, 1);
    assert.equal(f.bridge.state.healthChecks, 1);
    assert.equal(f.logs.length, 0);
  });
}

test('a command timeout is not replayed', async t => {
  const f = await fixture(t);
  await f.client.getDiscovery();
  f.bridge.state.onCommand = () => {}; // Accept the command without answering.
  await assert.rejects(f.client.execute(write, 100), { code: 'E_TIMEOUT' });
  assert.equal(f.bridge.state.dispatched.length, 1);
  assert.equal(f.logs.length, 0);
});

test('malformed JSON is not retried', async t => {
  const f = await fixture(t);
  f.bridge.state.onCommand = res => res.end('{');
  await assert.rejects(f.client.execute(write), { code: 'E_INVALID_RESPONSE' });
  assert.equal(f.bridge.state.dispatched.length, 1);
});
