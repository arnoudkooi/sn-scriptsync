import test from 'node:test';
import assert from 'node:assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { makeProject } from './sdkFixture.js';

/** A zip with one deflated entry, as the instance returns an app package. */
function makeZip(name: string, content: string): Buffer {
  const raw = Buffer.from(content);
  const data = zlib.deflateRawSync(raw);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(local.length + nameBuf.length + data.length, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

const SI = `sys_script_include_${'a'.repeat(32)}.xml`;
const instancePackage = (marker: string) => makeZip(`update/${SI}`,
  `<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><sys_id>${'a'.repeat(32)}</sys_id><name>Util</name><script>${marker}</script></sys_script_include></record_update>`).toString('base64');

async function withHelper(
  answer: (request: any) => any,
  body: (dispatcher: StandaloneDispatcher, cwd: string, sent: any[]) => Promise<void>
) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-sdkpull-'));
  fs.mkdirSync(path.join(tmpDir, 'dev123'));
  fs.writeFileSync(path.join(tmpDir, 'dev123', '_settings.json'), JSON.stringify({ name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'tok' }));
  const dispatcher = new StandaloneDispatcher({ cwd: tmpDir, wsBridge, pending, cliFlags: {} } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const sent: any[] = [];
  try {
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ action: 'helperBuildInfo', extensionName: 'SN Utils', extensionVersion: '10.2.5.0', capabilities: { protocolVersion: 1, sdkDeploy: 1, sdkPull: 1 } }));
    ws.send(JSON.stringify({ instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'tok' } }));
    await new Promise((r) => setTimeout(r, 30));
    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.action !== 'deployAppPackage' && request.action !== 'downloadAppPackage') return;
      sent.push(request);
      ws.send(JSON.stringify({ action: `${request.action}Response`, agentRequestId: request.agentRequestId, ...answer(request) }));
    });
    await body(dispatcher, tmpDir, sent);
  } finally {
    ws.close();
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('sdk_deploy: standalone host records a baseline and stops when the instance changed', async () => {
  let instanceVersion = 'v1';
  await withHelper((request) => request.action === 'downloadAppPackage'
    ? { success: true, packageBase64: instancePackage(instanceVersion) }
    : { success: true, flowActivation: null }, async (dispatcher, cwd, sent) => {
    makeProject(cwd, 'app-sync');
    const first: any = await dispatcher.dispatch({ id: 's1', command: 'sdk_deploy', instance: 'dev123', params: { projectPath: 'app-sync' } });
    assert.strictEqual(first.status, 'success', JSON.stringify(first));
    assert.strictEqual(first.result.baselineRecorded, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(cwd, 'app-sync', '.snu', 'deploy.json'), 'utf8')).instance, 'dev123');

    instanceVersion = 'v2';
    sent.length = 0;
    const changed: any = await dispatcher.dispatch({ id: 's2', command: 'sdk_deploy', instance: 'dev123', params: { projectPath: 'app-sync' } });
    assert.strictEqual(changed.code, 'E_INSTANCE_CHANGED', JSON.stringify(changed));
    assert.match(changed.error, /Script Include Util \(script\)/);
    assert.ok(!sent.some((m) => m.action === 'deployAppPackage'), 'no deploy was sent');

    const forced: any = await dispatcher.dispatch({ id: 's3', command: 'sdk_deploy', instance: 'dev123', params: { projectPath: 'app-sync', force: true } });
    assert.strictEqual(forced.status, 'success', JSON.stringify(forced));
    assert.deepStrictEqual(forced.result.overwritten, [{ label: 'Script Include Util', status: 'changed', file: SI, fields: ['script'] }]);
  });
});

test('sdk_deploy: a change check that fails stops the deploy unless forced', async () => {
  let downloadFails = false;
  await withHelper((request) => request.action === 'downloadAppPackage'
    ? (downloadFails ? { success: false, error: 'Session expired' } : { success: true, packageBase64: instancePackage('v1') })
    : { success: true, flowActivation: null }, async (dispatcher, cwd, sent) => {
    makeProject(cwd, 'app-check');
    const first: any = await dispatcher.dispatch({ id: 'c1', command: 'sdk_deploy', instance: 'dev123', params: { projectPath: 'app-check' } });
    assert.strictEqual(first.status, 'success', JSON.stringify(first));

    downloadFails = true;
    sent.length = 0;
    const stopped: any = await dispatcher.dispatch({ id: 'c2', command: 'sdk_deploy', instance: 'dev123', params: { projectPath: 'app-check' } });
    assert.strictEqual(stopped.code, 'E_CONFIRM_REQUIRED', JSON.stringify(stopped));
    assert.match(stopped.error, /Could not check dev123 .*Session expired/);
    assert.ok(!sent.some((m) => m.action === 'deployAppPackage'), 'no deploy was sent');

    const forced: any = await dispatcher.dispatch({ id: 'c3', command: 'sdk_deploy', instance: 'dev123', params: { projectPath: 'app-check', force: true } });
    assert.strictEqual(forced.status, 'success', JSON.stringify(forced));
    assert.strictEqual(forced.result.instanceChecked, false);
  });
});

test('sdk_pull: standalone host refuses outside git, lists with dryRun, applies in git', async () => {
  await withHelper(() => ({ success: true, packageBase64: instancePackage('p1') }), async (dispatcher, cwd, sent) => {
    const root = makeProject(cwd, 'app-pull');
    const file = `src/fluent/generated/${SI}`;

    const refused: any = await dispatcher.dispatch({ id: 'p1', command: 'sdk_pull', instance: 'dev123', params: { projectPath: 'app-pull' } });
    assert.strictEqual(refused.code, 'E_CONFIRM_REQUIRED', JSON.stringify(refused));
    assert.ok(!fs.existsSync(path.join(root, file)));

    const dry: any = await dispatcher.dispatch({ id: 'p2', command: 'sdk_pull', instance: 'dev123', params: { projectPath: 'app-pull', dryRun: true } });
    assert.deepStrictEqual(dry.result.changes, [{ path: file, status: 'added' }]);

    const git = (...args: string[]) => cp.execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    const applied: any = await dispatcher.dispatch({ id: 'p3', command: 'sdk_pull', instance: 'dev123', params: { projectPath: 'app-pull' } });
    assert.strictEqual(applied.status, 'success', JSON.stringify(applied));
    assert.deepStrictEqual(applied.result.applied, [file]);
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /p1/);
    assert.ok(sent.every((m) => m.initiatedBy === 'agent'));
  });
});

test('sdk_pull: a refused download keeps the helper tab\'s reason and code', async () => {
  await withHelper(() => ({ success: false, code: 'E_PRO_REQUIRED', error: 'Pulling NOW SDK apps is a SN Utils Pro feature.' }), async (dispatcher, cwd) => {
    makeProject(cwd, 'app-pro');
    const res: any = await dispatcher.dispatch({ id: 'p4', command: 'sdk_pull', instance: 'dev123', params: { projectPath: 'app-pro' } });
    assert.strictEqual(res.code, 'E_PRO_REQUIRED', JSON.stringify(res));
  });
});
