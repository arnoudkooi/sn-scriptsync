import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';

test('replacement rejects old requests but keeps new requests and session state after a late close', async t => {
  const pending = new PendingRegistry();
  const bridge = new StandaloneWsBridge(0, pending);
  const port = await bridge.start();
  t.after(() => bridge.close());
  const old = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => old.terminate());
  await once(old, 'message'); // hostHello confirms the helper is accepted
  const oldServer = (bridge as any).activeClient as WebSocket;
  const oldRequest = assert.rejects(
    pending.register({ id: 'old', command: 'query' }),
    { code: 'E_BROWSER_DISCONNECTED' },
  );
  const replacement = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => replacement.terminate());
  await once(replacement, 'message');
  await oldRequest;

  const response = pending.register({ id: 'new', command: 'query' });
  const server = (bridge as any).activeClient as WebSocket;
  server.emit('message', Buffer.from(JSON.stringify({
    instance: { name: 'new', url: 'https://new.service-now.com', g_ck: 'test-session' },
  })));
  oldServer.emit('close');
  oldServer.emit('message', Buffer.from(JSON.stringify({
    instance: { name: 'stale', url: 'https://stale.service-now.com', g_ck: 'stale-session' },
    agentRequestId: 'new', success: true, data: 'stale response',
  })));
  assert.equal(bridge.hasBrowserClient(), true);
  assert.deepEqual(bridge.getLiveInstances().map(i => i.name), ['new']);
  replacement.send(JSON.stringify({ agentRequestId: 'new', success: true, data: 'fresh response' }));
  assert.equal((await response).data, 'fresh response');
});

test('a helper that does not answer WebSocket pings is disconnected and pending requests fail', async t => {
  const pending = new PendingRegistry();
  const bridge = new StandaloneWsBridge(0, pending, 100);
  const port = await bridge.start();
  t.after(() => bridge.close());
  const helper = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
  t.after(() => helper.terminate());
  await once(helper, 'message');
  const rejected = assert.rejects(
    pending.register({ id: 'hung', command: 'query' }),
    { code: 'E_BROWSER_DISCONNECTED' },
  );
  await once(helper, 'close', { signal: AbortSignal.timeout(3000) });
  await rejected;
  assert.equal(bridge.hasBrowserClient(), false);
  assert.deepEqual(bridge.getLiveInstances(), []);
});

// SNU0000010172 / SNU0000010089: two Chrome profiles, one helper tab each.
test('a newly opened helper takes over with a reason; an automatic reconnect stands by', async () => {
  const bridge = new StandaloneWsBridge(0, new PendingRegistry(), 30_000, 'd'.repeat(64));
  const port = await bridge.start();
  const open = async (suffix = '') => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${suffix}`);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await once(ws, 'open');
    return { ws, closed };
  };
  try {
    const profileA = await open();
    const profileB = await open();
    assert.strictEqual(await profileA.closed, 4001, 'the replaced helper is told it was replaced');

    // Profile A reconnects on its own, as a helper tab does after any close.
    const resumed = await open('?resume=1');
    assert.strictEqual(await resumed.closed, 4002, 'the automatic reconnect is turned away');
    assert.strictEqual(bridge.hasBrowserClient(), true);
    assert.strictEqual(profileB.ws.readyState, WebSocket.OPEN, 'the live helper keeps its connection');

    // Profile B goes away: now the automatic reconnect is welcome.
    profileB.ws.close();
    await profileB.closed;
    await new Promise((r) => setTimeout(r, 30));
    const back = await open('?resume=1');
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(back.ws.readyState, WebSocket.OPEN);
    assert.strictEqual(bridge.hasBrowserClient(), true);
    back.ws.close();
  } finally {
    await bridge.close();
  }
});
