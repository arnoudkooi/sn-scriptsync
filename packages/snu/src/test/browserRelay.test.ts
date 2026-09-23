import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher, BROWSER_ACTIONS } from '../server/dispatcher.js';

// Action names the SN Utils helper tab dispatches on (scriptsync.js in the
// extension). The helper drops an unknown action without replying, so a drift
// here is only ever seen as E_TIMEOUT by the user. Update both sides together.
const HELPER_TAB_ACTIONS: Record<string, string> = {
  get_form_state: 'agentGetFormState',
  set_field: 'agentSetField',
  run_ui_action: 'agentRunUiAction',
  navigate: 'agentNavigate',
  take_screenshot: 'takeScreenshot',
  switch_context: 'switchContext',
};

test('Browser relay: dispatcher action names match the helper tab handlers', () => {
  assert.deepStrictEqual({ ...BROWSER_ACTIONS }, HELPER_TAB_ACTIONS);
});

type Harness = {
  wsBridge: StandaloneWsBridge;
  pending: PendingRegistry;
  ws: WebSocket;
  tmpDir: string;
  received: any[];
  close: () => Promise<void>;
};

async function connectHelper(): Promise<Harness> {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-browser-relay-'));
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const received: any[] = [];
  ws.on('message', (data) => {
    try { received.push(JSON.parse(data.toString())); } catch {}
  });
  await new Promise<void>((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({
    instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'live-session-token' },
  }));
  await new Promise((r) => setTimeout(r, 30));
  return {
    wsBridge, pending, ws, tmpDir, received,
    close: async () => {
      ws.close();
      await wsBridge.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for browser message');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('Helper state: cdp is derived from the build and the license, never a placeholder', async () => {
  const h = await connectHelper();
  try {
    // Nothing known yet: no reason is claimed.
    assert.deepStrictEqual(h.wsBridge.getHelperState().cdp, { available: false, reason: null });

    // Debug edition, then a Pro license: the debugger is usable.
    h.ws.send(JSON.stringify({ action: 'helperBuildInfo', debuggerAvailable: true, capabilities: { protocolVersion: 1 } }));
    h.ws.send(JSON.stringify({ action: 'helperLicenseInfo', tier: 'pro', proFeatures: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(h.wsBridge.getHelperState().cdp, { available: true, reason: null });
    assert.strictEqual(h.wsBridge.getHelperState().tier, 'pro');

    // Same build without Pro.
    h.ws.send(JSON.stringify({ action: 'helperLicenseInfo', tier: 'free', proFeatures: false }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(h.wsBridge.getHelperState().cdp, { available: false, reason: 'E_PRO_REQUIRED' });

    // Regular build: the reason is the build, whatever the license says.
    h.ws.send(JSON.stringify({ action: 'helperBuildInfo', debuggerAvailable: false }));
    h.ws.send(JSON.stringify({ action: 'helperLicenseInfo', tier: 'pro', proFeatures: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(h.wsBridge.getHelperState().cdp, { available: false, reason: 'E_CDP_UNAVAILABLE' });

    // An explicit report from the helper still wins.
    h.ws.send(JSON.stringify({ action: 'helperBuildInfo', cdp: { available: true, reason: null } }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(h.wsBridge.getHelperState().cdp, { available: true, reason: null });
  } finally {
    await h.close();
  }
});

test('take_screenshot: sends takeScreenshot with the debugger opt-in and saves the PNG', async () => {
  const h = await connectHelper();
  try {
    const dispatcher = new StandaloneDispatcher({ cwd: h.tmpDir, wsBridge: h.wsBridge, pending: h.pending, cliFlags: { browserDebugger: true } } as any);
    const png = Buffer.from('not really a png, but bytes');
    const resultPromise = dispatcher.dispatch({ id: 'shot1', command: 'take_screenshot', params: { url: 'https://dev123.service-now.com/*', fileName: 'form' } });

    const msg = await waitFor(() => h.received.find((m) => m.action === 'takeScreenshot'));
    assert.strictEqual(msg.allowDebugger, true);
    assert.strictEqual(msg.url, 'https://dev123.service-now.com/*');
    assert.strictEqual(msg.fileName, 'form.png');
    assert.ok(msg.agentRequestId);

    h.ws.send(JSON.stringify({
      action: 'screenshotResponse',
      agentRequestId: msg.agentRequestId,
      imageData: png.toString('base64'),
      fileName: 'ignored_by_host.png',
      url: 'https://dev123.service-now.com/incident.do',
      tabId: 42,
      tabTitle: 'Incident',
      capturedVia: 'debugger',
    }));

    const resp = await resultPromise;
    assert.strictEqual(resp.status, 'success', resp.error);
    assert.strictEqual(resp.result.saved, true);
    assert.strictEqual(resp.result.capturedVia, 'debugger');
    assert.strictEqual(resp.result.tabId, 42);
    assert.strictEqual(resp.result.filePath, path.join(h.tmpDir, 'screenshots', 'form.png'));
    assert.ok(fs.readFileSync(resp.result.filePath).equals(png));
  } finally {
    await h.close();
  }
});

test('take_screenshot: no debugger opt-in by default, and a permission refusal is retried once', async () => {
  const h = await connectHelper();
  try {
    const dispatcher = new StandaloneDispatcher({ cwd: h.tmpDir, wsBridge: h.wsBridge, pending: h.pending, cliFlags: { browserDebugger: false } } as any);
    dispatcher.screenshotRetryDelayMs = 20;
    // Debug edition with Pro on the other end: the refusal must say which
    // host permission would let the debugger capture instead.
    h.ws.send(JSON.stringify({ action: 'helperBuildInfo', debuggerAvailable: true }));
    h.ws.send(JSON.stringify({ action: 'helperLicenseInfo', tier: 'pro', proFeatures: true }));
    await new Promise((r) => setTimeout(r, 30));
    const resultPromise = dispatcher.dispatch({ id: 'shot2', command: 'take_screenshot', params: { tabId: 7 } });

    const first = await waitFor(() => h.received.find((m) => m.action === 'takeScreenshot'));
    assert.strictEqual(first.allowDebugger, false);
    assert.strictEqual(first.tabId, 7);
    h.ws.send(JSON.stringify({
      action: 'screenshotResponse',
      agentRequestId: first.agentRequestId,
      success: false,
      code: 'E_SCREENSHOT_PERMISSION',
      error: 'Screenshot requires permission.',
      tabId: 9,
      tabUrl: 'https://dev123.service-now.com/incident.do',
    }));

    const second = await waitFor(() => h.received.filter((m) => m.action === 'takeScreenshot')[1]);
    assert.strictEqual(second.tabId, 9, 'retry targets the tab the helper named');
    assert.notStrictEqual(second.agentRequestId, first.agentRequestId);
    h.ws.send(JSON.stringify({
      action: 'screenshotResponse',
      agentRequestId: second.agentRequestId,
      success: false,
      code: 'E_SCREENSHOT_PERMISSION',
      error: 'Screenshot requires permission.',
      tabId: 9,
    }));

    const resp = await resultPromise;
    assert.strictEqual(resp.status, 'error');
    assert.strictEqual(resp.code, 'E_SCREENSHOT_PERMISSION');
    assert.strictEqual(resp.details?.tabId, 9);
    assert.strictEqual(resp.details?.browserDebuggerGate, 'off');
    assert.strictEqual(resp.details?.cdpFallbackAvailable, true);
    assert.match(resp.error || '', /SNU_ALLOW_BROWSER_DEBUGGER=1/);
    assert.doesNotMatch(resp.error || '', /capture_full_page/);
    assert.ok(!fs.existsSync(path.join(h.tmpDir, 'screenshots')));
  } finally {
    await h.close();
  }
});

test('switch_context: relays switchContext with the instance session and normalises the type', async () => {
  const h = await connectHelper();
  try {
    const dispatcher = new StandaloneDispatcher({ cwd: h.tmpDir, wsBridge: h.wsBridge, pending: h.pending });
    const sysId = 'fadd6ea087e7871035f50fac8bbb35b5';
    const resultPromise = dispatcher.dispatch({ id: 'sw1', command: 'switch_context', params: { switchType: 'app', value: sysId, reloadTab: false } });

    const msg = await waitFor(() => h.received.find((m) => m.action === 'switchContext'));
    assert.strictEqual(msg.switchType, 'application');
    assert.strictEqual(msg.value, sysId);
    assert.strictEqual(msg.reloadTab, false);
    assert.strictEqual(msg.tabUrl, 'https://*.service-now.com/*');
    assert.strictEqual(msg.instance.url, 'https://dev123.service-now.com');
    assert.strictEqual(msg.instance.g_ck, 'live-session-token');

    h.ws.send(JSON.stringify({
      action: 'switchContextResponse',
      agentRequestId: msg.agentRequestId,
      success: true,
      switchType: 'application',
      value: sysId,
      reloaded: false,
    }));
    const resp = await resultPromise;
    assert.strictEqual(resp.status, 'success', resp.error);
    assert.deepStrictEqual(resp.result, { switched: true, switchType: 'application', value: sysId, reloaded: false });

    // Helper-side failure surfaces as an error response, not a success.
    const failing = dispatcher.dispatch({ id: 'sw2', command: 'switch_context', params: { switchType: 'updateset', value: sysId } });
    const msg2 = await waitFor(() => h.received.filter((m) => m.action === 'switchContext')[1]);
    assert.strictEqual(msg2.reloadTab, true);
    h.ws.send(JSON.stringify({ action: 'switchContextResponse', agentRequestId: msg2.agentRequestId, success: false, error: 'Update set not found' }));
    const failed = await failing;
    assert.strictEqual(failed.status, 'error');
    assert.match(failed.error || '', /Update set not found/);

    // Bad input never reaches the browser.
    const invalid = await dispatcher.dispatch({ id: 'sw3', command: 'switch_context', params: { switchType: 'table', value: sysId } });
    assert.strictEqual(invalid.code, 'E_INVALID_PARAMS');
    const missing = await dispatcher.dispatch({ id: 'sw4', command: 'switch_context', params: { switchType: 'domain' } });
    assert.strictEqual(missing.code, 'E_INVALID_PARAMS');
    assert.strictEqual(h.received.filter((m) => m.action === 'switchContext').length, 2);
  } finally {
    await h.close();
  }
});
