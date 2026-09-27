import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { makeProject } from './sdkFixture.js';

const SCOPE_ID = 'f64ef56e39704a9e80aee2ece02d22e1';
const FLOW_ID = 'c'.repeat(32);

async function withBridge(
  capabilities: Record<string, any>,
  onDeploy: (request: any, reply: (payload: any) => void) => void,
  body: (dispatcher: StandaloneDispatcher, cwd: string) => Promise<void>
) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-sdkdeploy-'));
  fs.mkdirSync(path.join(tmpDir, 'dev123'));
  fs.writeFileSync(path.join(tmpDir, 'dev123', '_settings.json'), JSON.stringify({ name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'tok' }));
  makeProject(tmpDir, 'app-one');
  const dispatcher = new StandaloneDispatcher({ cwd: tmpDir, wsBridge, pending, cliFlags: {} } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  try {
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ action: 'helperBuildInfo', extensionName: 'SN Utils', extensionVersion: '10.2.5.0', capabilities: { protocolVersion: 1, ...capabilities } }));
    ws.send(JSON.stringify({ instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'tok' } }));
    await new Promise((r) => setTimeout(r, 30));
    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.action !== 'deployAppPackage') return;
      onDeploy(request, (payload) => ws.send(JSON.stringify({ action: 'deployAppPackageResponse', agentRequestId: request.agentRequestId, ...payload })));
    });
    await body(dispatcher, tmpDir);
  } finally {
    ws.close();
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('sdk_deploy: standalone host builds, sends one agent deploy and reports the install', async () => {
  const seen: any[] = [];
  await withBridge({ sdkDeploy: 1 }, (request, reply) => {
    seen.push(request);
    reply({ success: true, rollbackUrl: 'https://dev123.service-now.com/sys_rollback_context.do?sys_id=r', flowActivation: { ok: true, total: 1, succeeded: 1, failed: 0 }, durationMs: 3100 });
  }, async (dispatcher) => {
    const response = await dispatcher.dispatch({ id: 'd1', command: 'sdk_deploy', instance: 'dev123', params: { projectPath: 'app-one' } });
    assert.strictEqual(response.status, 'success', JSON.stringify(response));
    const result: any = response.result;
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.partial, false);
    assert.deepStrictEqual(result.app, { name: 'Spike', scope: 'x_1849902_flspk', version: '0.0.1' });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].initiatedBy, 'agent');
    assert.deepStrictEqual(seen[0].flows, [FLOW_ID]);
    assert.strictEqual(seen[0].instance.g_ck, 'tok');
  });
});

test('sdk_deploy: partial activation and failures come back as the right shape', async () => {
  const replies = [
    { success: true, flowActivation: { ok: false, total: 2, succeeded: 1, failed: 1 } },
    { success: false, code: 'E_USER_REJECTED', error: 'Deploy cancelled in the ScriptSync helper tab.' },
    { success: false, error: 'Unable to install application as application was null', reason: 'Not allowing install of third party application', trackerUrl: 'https://dev123.service-now.com/sys_execution_tracker.do?sys_id=t' },
  ];
  await withBridge({ sdkDeploy: 1 }, (_request, reply) => reply(replies.shift()!), async (dispatcher) => {
    const partial = await dispatcher.dispatch({ id: 'd2', command: 'sdk_deploy', instance: 'dev123', params: {} });
    assert.strictEqual(partial.status, 'success');
    assert.strictEqual((partial.result as any).partial, true);

    const rejected: any = await dispatcher.dispatch({ id: 'd3', command: 'sdk_deploy', instance: 'dev123', params: {} });
    assert.strictEqual(rejected.status, 'error');
    assert.strictEqual(rejected.code, 'E_USER_REJECTED');

    const failed: any = await dispatcher.dispatch({ id: 'd4', command: 'sdk_deploy', instance: 'dev123', params: {} });
    assert.strictEqual(failed.code, 'E_COMMAND_FAILED');
    assert.match(failed.error, /third party/);
    assert.match(failed.details.trackerUrl, /sys_execution_tracker/);
  });
});

test('sdk_deploy: an old helper and a path outside the workspace are refused without a deploy', async () => {
  let deploys = 0;
  await withBridge({}, () => { deploys++; }, async (dispatcher) => {
    const old: any = await dispatcher.dispatch({ id: 'd5', command: 'sdk_deploy', instance: 'dev123', params: {} });
    assert.strictEqual(old.code, 'E_UNSUPPORTED_HOST');
  });
  await withBridge({ sdkDeploy: 1 }, () => { deploys++; }, async (dispatcher) => {
    const outside: any = await dispatcher.dispatch({ id: 'd6', command: 'sdk_deploy', instance: 'dev123', params: { projectPath: '../../etc' } });
    assert.strictEqual(outside.code, 'E_INVALID_PARAMS');
  });
  assert.strictEqual(deploys, 0);
});
