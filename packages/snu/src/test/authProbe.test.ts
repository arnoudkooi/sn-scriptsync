import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { classifyProbe, helperFailureHint } from '../server/authProbe.js';

/**
 * Reported by Tyler Hodges: an instance reached through both its
 * service-now.com name and a load balancer hostname. The agent saw
 * AUTH_UNKNOWN ("retry") and E_INSTANCE_NOT_FOUND with nothing to act on.
 */

const DEV = 'https://dev123.service-now.com';
const ALB = 'https://sn-dev.internal.example.com';

test('classifyProbe: statuses keep their meaning', () => {
  assert.strictEqual(classifyProbe({ status: 401, hasLiveSession: true }).state, 'AUTH_EXPIRED');
  assert.strictEqual(classifyProbe({ status: 403, hasLiveSession: true }).state, 'AUTH_OK');
  assert.strictEqual(classifyProbe({ status: 200, hasLiveSession: true }).state, 'AUTH_OK');
});

test('classifyProbe: a missing token is AUTH_MISSING, not "retry"', () => {
  const v = classifyProbe({ error: 'Missing instance URL or authentication token', origin: DEV, hasLiveSession: false });
  assert.strictEqual(v.state, 'AUTH_MISSING');
  assert.match(v.message, /run \/token/);
  assert.match(v.message, /dev123\.service-now\.com/);
});

test('classifyProbe: a hostname the helper tab has not approved is AUTH_MISSING with the way out', () => {
  const v = classifyProbe({ error: `Fetch to unapproved instance URL blocked: ${ALB}`, origin: ALB, hasLiveSession: true });
  assert.strictEqual(v.state, 'AUTH_MISSING');
  assert.match(v.message, /has not approved/);
});

test('classifyProbe: an unreachable non-ServiceNow hostname points at the OnPrem build', () => {
  const v = classifyProbe({ error: 'Failed to fetch', origin: ALB, hasLiveSession: true });
  assert.strictEqual(v.state, 'AUTH_UNKNOWN');
  assert.match(v.message, /OnPrem build/);
  assert.doesNotMatch(classifyProbe({ error: 'Failed to fetch', origin: DEV, hasLiveSession: true }).message, /OnPrem/);
});

test('classifyProbe: an unexplained failure with no session ever received reads as missing', () => {
  assert.strictEqual(classifyProbe({ error: 'boom', origin: DEV, hasLiveSession: false }).state, 'AUTH_MISSING');
  assert.strictEqual(classifyProbe({ error: 'boom', origin: DEV, hasLiveSession: true }).state, 'AUTH_UNKNOWN');
});

test('helperFailureHint: stays silent when it has nothing to add', () => {
  assert.strictEqual(helperFailureHint('Record not found', DEV), '');
});

async function withBridge(
  setup: { folders?: Record<string, any>; tokens?: any[] },
  onRest: (request: any, reply: (payload: any) => void) => void,
  body: (dispatcher: StandaloneDispatcher) => Promise<void>
) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-authprobe-'));
  for (const [name, settings] of Object.entries(setup.folders || {})) {
    fs.mkdirSync(path.join(tmpDir, name));
    fs.writeFileSync(path.join(tmpDir, name, '_settings.json'), JSON.stringify(settings));
  }
  const dispatcher = new StandaloneDispatcher({ cwd: tmpDir, wsBridge, pending, cliFlags: {} } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  try {
    await new Promise<void>((resolve) => ws.on('open', resolve));
    for (const instance of setup.tokens || []) ws.send(JSON.stringify({ instance }));
    await new Promise((r) => setTimeout(r, 30));
    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.action !== 'agentRestApi') return;
      onRest(request, (payload) => ws.send(JSON.stringify({ agentRequestId: request.agentRequestId, ...payload })));
    });
    await body(dispatcher);
  } finally {
    ws.close();
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('auth_status: a workspace instance without a token is AUTH_MISSING and never probes', async () => {
  let probed = false;
  await withBridge({ folders: { dev123: { name: 'dev123', url: DEV } } }, () => { probed = true; }, async (dispatcher) => {
    const res: any = await dispatcher.dispatch({ id: 'a1', command: 'auth_status', instance: 'dev123' } as any);
    assert.strictEqual(res.result.state, 'AUTH_MISSING');
    assert.match(res.result.message, /run \/token/);
    assert.strictEqual(probed, false);
  });
});

test('auth_status: the helper tab refusing an unapproved hostname is explained', async () => {
  await withBridge(
    { tokens: [{ name: 'sn-dev', url: ALB, g_ck: 'tok' }] },
    (request, reply) => reply({ success: false, error: `Fetch to unapproved instance URL blocked: ${request.instance.url}` }),
    async (dispatcher) => {
      const res: any = await dispatcher.dispatch({ id: 'a2', command: 'auth_status', instance: 'sn-dev' } as any);
      assert.strictEqual(res.result.state, 'AUTH_MISSING');
      assert.match(res.result.message, /has not approved/);
      assert.match(String(res.result.detail), /unapproved/);
    });
});

test('auth_status: a working session still reads AUTH_OK', async () => {
  await withBridge(
    { tokens: [{ name: 'dev123', url: DEV, g_ck: 'tok' }] },
    (_request, reply) => reply({ success: true, status: 200, data: { result: [] } }),
    async (dispatcher) => {
      const res: any = await dispatcher.dispatch({ id: 'a3', command: 'auth_status', instance: 'dev123' } as any);
      assert.strictEqual(res.result.state, 'AUTH_OK');
      assert.strictEqual(res.result.ok, true);
    });
});

test('an unknown instance name lists what is connected, under both hostnames', async () => {
  await withBridge(
    { tokens: [{ name: 'dev123', url: DEV, g_ck: 'tok' }, { name: 'sn-dev', url: ALB, g_ck: 'tok2' }] },
    () => {},
    async (dispatcher) => {
      assert.throws(
        () => dispatcher.resolveInstance('ATOA'),
        (err: any) => err.code === 'E_INSTANCE_NOT_FOUND'
          && /dev123 \(https:\/\/dev123\.service-now\.com\)/.test(err.message)
          && /sn-dev \(https:\/\/sn-dev\.internal\.example\.com\)/.test(err.message)
          && err.details.liveInstances.length === 2
      );
      assert.strictEqual(dispatcher.resolveInstance('sn-dev.internal.example.com').settings.url, ALB);
    });
});
