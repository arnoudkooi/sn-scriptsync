import test from 'node:test';
import assert from 'node:assert';
import { requestEditorBridgeLifecycle, ActiveBridgeStatus } from '../cli/daemon.js';

function editorStatus(): ActiveBridgeStatus {
  return {
    running: true,
    discovery: {
      port: 1977,
      token: 'tok',
      pid: 4242,
      apiVersion: 9,
      portFilePath: '/tmp/agent-port.json',
      isGlobal: true,
    },
    health: {
      status: 'success',
      apiVersion: 9,
      hostKind: 'vscode',
      commands: [],
      pid: 4242,
      extensionVersion: '4.9.0',
    },
  };
}

function fakeFetch(response: { ok: boolean; status: number; body: any }) {
  const seen: any[] = [];
  const impl = async (url: string, init: any) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    };
  };
  return { impl: impl as any, seen };
}

test('a yield goes to POST /api with the bridge token', async () => {
  const { impl, seen } = fakeFetch({ ok: true, status: 200, body: { status: 'success' } });

  await requestEditorBridgeLifecycle(editorStatus(), 'yield', impl);

  assert.strictEqual(seen.length, 1);
  // The editor host routes everything through /api — /api/yield is standalone-only.
  assert.strictEqual(seen[0].url, 'http://127.0.0.1:1977/api');
  assert.strictEqual(seen[0].init.method, 'POST');
  assert.strictEqual(seen[0].init.headers['X-Agent-Token'], 'tok');
  assert.strictEqual(seen[0].body.command, 'yield');
});

test('a restart sends the restart command', async () => {
  const { impl, seen } = fakeFetch({ ok: true, status: 200, body: { status: 'success' } });

  await requestEditorBridgeLifecycle(editorStatus(), 'restart', impl);

  assert.strictEqual(seen[0].body.command, 'restart');
});

test('an HTTP failure surfaces as E_STOP_FAILED rather than resolving', async () => {
  const { impl } = fakeFetch({ ok: false, status: 500, body: { status: 'error', error: 'boom' } });

  await assert.rejects(
    () => requestEditorBridgeLifecycle(editorStatus(), 'yield', impl),
    (err: any) => err.code === 'E_STOP_FAILED' && /boom/.test(err.message)
  );
});

test('a bridge that answers 200 but not success is still a failure', async () => {
  const { impl } = fakeFetch({ ok: true, status: 200, body: { status: 'error', error: 'unsupported' } });

  await assert.rejects(
    () => requestEditorBridgeLifecycle(editorStatus(), 'restart', impl),
    (err: any) => err.code === 'E_RESTART_FAILED'
  );
});
