import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { createHarness, stubVscode } from './helpers/commandHarness';
import { makeZip } from './helpers/zip';

const harness = createHarness();
stubVscode(harness.workspaceRoot);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sdkCommands } = require('../agent/commands/sdk');
const deploy = sdkCommands.find((c: any) => c.name === 'sdk_deploy');

const SCOPE_ID = 'f64ef56e39704a9e80aee2ece02d22e1';
const FLOW_ID = 'c'.repeat(32);
const PRO_HELPER = { capabilities: { sdkDeploy: 1 }, licenseResolved: true, proFeatures: true };

fs.writeFileSync(path.join(harness.instanceFolder, '_settings.json'),
	JSON.stringify({ name: 'testinst', url: 'https://testinst.service-now.com', g_ck: 'tok123' }));

/** A NOW SDK project whose now-sdk is a small script producing build output and a zip. */
function makeProject(name: string, withCli = true): string {
	const root = path.join(harness.workspaceRoot, name);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, 'now.config.json'), JSON.stringify({ scope: 'x_1849902_flspk', scopeId: SCOPE_ID, name: 'Spike' }));
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '0.0.1' }));
	if (withCli) {
		const bin = path.join(root, 'node_modules', '.bin');
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(path.join(root, 'node_modules', '@servicenow', 'sdk'), { recursive: true });
		fs.writeFileSync(path.join(root, 'node_modules', '@servicenow', 'sdk', 'package.json'), JSON.stringify({ version: '4.13.0' }));
		const script = [
			'#!/bin/sh',
			'if [ "$1" = "build" ]; then',
			'  mkdir -p dist/app/update',
			`  touch dist/app/update/sys_hub_flow_${FLOW_ID}.xml dist/app/update/sys_script_include_${'d'.repeat(32)}.xml`,
			`  printf '%s' '<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><sys_id>${'a'.repeat(32)}</sys_id><name>Util</name><script>v1</script></sys_script_include></record_update>' > dist/app/update/sys_script_include_${'a'.repeat(32)}.xml`,
			'  echo "Build completed successfully"',
			'elif [ "$1" = "pack" ]; then',
			'  mkdir -p target',
			`  printf 'PK\\003\\004 /scope/sys_app_${SCOPE_ID}.xml' > target/spike_0_0_1.zip`,
			'  echo "Single artifact emitted as \\"$(pwd)/target/spike_0_0_1.zip\\"."',
			'elif [ "$1" = "transform" ]; then',
			'  mkdir -p src/fluent/generated && cp "$3"/update/* src/fluent/generated/',
			'fi',
		].join('\n');
		fs.writeFileSync(path.join(bin, 'now-sdk'), script, { mode: 0o755 });
	}
	return root;
}

makeProject('app-one');

const ctx = (overrides: any = {}) => harness.context({ getHelperBuildInfo: () => PRO_HELPER, request: { id: 'deploy_1', command: 'sdk_deploy', params: {} }, ...overrides });

test.afterEach(() => { harness.sent.length = 0; });
test.after(() => harness.cleanup());

test('an old helper without sdkDeploy is refused before building', async () => {
	await assert.rejects(deploy.handle(ctx({ getHelperBuildInfo: () => ({ capabilities: {} }) }), {}), (e: any) => e.code === 'E_UNSUPPORTED_HOST');
	assert.strictEqual(harness.sent.length, 0);
});

test('a Community helper gets E_PRO_REQUIRED before building', async () => {
	await assert.rejects(deploy.handle(ctx({ getHelperBuildInfo: () => ({ capabilities: { sdkDeploy: 1 }, licenseResolved: true, proFeatures: false }) }), {}), (e: any) => e.code === 'E_PRO_REQUIRED');
	assert.strictEqual(harness.sent.length, 0);
});

test('a successful deploy sends one agent-initiated package and reports the install', async () => {
	harness.reply({ action: 'deployAppPackageResponse', success: true, statusMessage: 'Application installed successfully', rollbackUrl: 'https://testinst.service-now.com/sys_rollback_context.do?sys_id=x', flowActivation: { ok: true, total: 1, succeeded: 1, failed: 0 }, durationMs: 4200 });
	const result = await deploy.handle(ctx(), { projectPath: 'app-one' });
	assert.strictEqual(harness.sent.length, 1);
	const msg = harness.sent[0];
	assert.strictEqual(msg.action, 'deployAppPackage');
	assert.strictEqual(msg.initiatedBy, 'agent');
	assert.deepStrictEqual(msg.app, { name: 'Spike', scope: 'x_1849902_flspk', scopeId: SCOPE_ID, version: '0.0.1' });
	assert.deepStrictEqual(msg.instance, { name: 'testinst', url: 'https://testinst.service-now.com', g_ck: 'tok123' });
	assert.deepStrictEqual(msg.flows, [FLOW_ID]);
	assert.ok(Buffer.from(msg.packageBase64, 'base64').subarray(0, 2).toString() === 'PK');
	assert.strictEqual(result.success, true);
	assert.strictEqual(result.installed, true);
	assert.strictEqual(result.partial, false);
	assert.strictEqual(result.app.version, '0.0.1');
});

test('an install with failed flow activation is reported as partial, not as an error', async () => {
	harness.reply({ success: true, flowActivation: { ok: false, total: 2, succeeded: 1, failed: 1 } });
	const result = await deploy.handle(ctx(), { projectPath: 'app-one' });
	assert.strictEqual(result.installed, true);
	assert.strictEqual(result.partial, true);
	assert.strictEqual(result.success, false);
});

test('a failed install throws with the tracker and the logged reason', async () => {
	harness.reply({ success: false, error: 'Unable to install application as application was null', reason: 'Not allowing install of third party application', trackerUrl: 'https://testinst.service-now.com/sys_execution_tracker.do?sys_id=t' });
	await assert.rejects(deploy.handle(ctx(), { projectPath: 'app-one' }), (e: any) =>
		e.code === 'E_COMMAND_FAILED' && e.message.includes('third party') && e.details?.trackerUrl?.includes('sys_execution_tracker') && e.details?.installed === false);
});

test('cancelling in the helper tab is E_USER_REJECTED', async () => {
	harness.reply({ success: false, code: 'E_USER_REJECTED', error: 'Deploy cancelled in the ScriptSync helper tab.' });
	await assert.rejects(deploy.handle(ctx(), { projectPath: 'app-one' }), (e: any) => e.code === 'E_USER_REJECTED');
});

test('no answer in time says the outcome is unknown', async () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { AgentError } = require('../agent/errors');
	harness.replyWithError(new AgentError('E_TIMEOUT', 'Timed out'));
	await assert.rejects(deploy.handle(ctx(), { projectPath: 'app-one' }), (e: any) => e.code === 'E_TIMEOUT' && /may still have finished/.test(e.message));
});

test('a projectPath outside the workspace is refused', async () => {
	await assert.rejects(deploy.handle(ctx(), { projectPath: '../../etc' }), (e: any) => e.code === 'E_INVALID_PARAMS');
	assert.strictEqual(harness.sent.length, 0);
});

test('without projectPath one project is picked, several need a projectPath', async () => {
	harness.reply({ success: true });
	const result = await deploy.handle(ctx(), {});
	assert.strictEqual(result.installed, true);
	makeProject('app-two', false);
	await assert.rejects(deploy.handle(ctx(), {}), (e: any) => e.code === 'E_INVALID_PARAMS' && /app-one/.test(e.message) && /app-two/.test(e.message));
});

test('a project without the SDK installed says to run npm install', async () => {
	await assert.rejects(deploy.handle(ctx(), { projectPath: 'app-two' }), (e: any) => e.code === 'E_INVALID_PARAMS' && /npm install/.test(e.message));
});

// ---- Change check, baseline and pull ----------------------------------------

const PULL_HELPER = { capabilities: { sdkDeploy: 1, sdkPull: 1 }, licenseResolved: true, proFeatures: true };
const pull = sdkCommands.find((c: any) => c.name === 'sdk_pull');
const syncCtx = () => ctx({ getHelperBuildInfo: () => PULL_HELPER });
const instancePackage = (marker: string) => ({
	success: true,
	packageBase64: makeZip([{ name: `update/sys_script_include_${'a'.repeat(32)}.xml`, content: `<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><sys_id>${'a'.repeat(32)}</sys_id><name>Util</name><script>${marker}</script></sys_script_include></record_update>` }]).toString('base64'),
});
const installed = { success: true, flowActivation: null };

test('deploy records the baseline, stops when the instance changed, and deploys with force', async () => {
	const root = makeProject('app-sync');
	// First deploy: no baseline yet, so no check; the baseline is recorded after the install.
	harness.reply(installed);
	harness.reply(instancePackage('v1'));
	const first = await deploy.handle(syncCtx(), { projectPath: 'app-sync' });
	assert.strictEqual(first.installed, true);
	assert.strictEqual(first.baselineRecorded, true);
	assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, '.snu', 'deploy.json'), 'utf8')).instance, 'testinst');
	harness.sent.length = 0;

	// Someone changed the Script Include on the instance: the deploy stops before anything is sent.
	harness.reply(instancePackage('v2'));
	await assert.rejects(deploy.handle(syncCtx(), { projectPath: 'app-sync' }), (e: any) =>
		e.code === 'E_INSTANCE_CHANGED' && /Script Include Util \(script\)/.test(e.message) && e.details?.changes?.length === 1);
	assert.ok(!harness.sent.some((m) => m.action === 'deployAppPackage'), 'no deploy was sent');

	// With force it deploys and says what it overwrote.
	harness.reply(instancePackage('v2'));
	harness.reply(installed);
	harness.reply(instancePackage('v2'));
	const forced = await deploy.handle(syncCtx(), { projectPath: 'app-sync', force: true });
	assert.strictEqual(forced.installed, true);
	assert.deepStrictEqual(forced.overwritten, [{ label: 'Script Include Util', status: 'changed', file: `sys_script_include_${'a'.repeat(32)}.xml`, fields: ['script'] }]);

	// The baseline now matches the instance, so the next deploy goes through.
	harness.reply(instancePackage('v2'));
	harness.reply(installed);
	harness.reply(instancePackage('v2'));
	const again = await deploy.handle(syncCtx(), { projectPath: 'app-sync' });
	assert.strictEqual(again.installed, true);
	assert.strictEqual(again.overwritten, undefined);
});

test('a change check that fails stops the deploy unless forced, and the result says it was not checked', async () => {
	makeProject('app-check');
	harness.reply(installed);
	harness.reply(instancePackage('v1'));
	await deploy.handle(syncCtx(), { projectPath: 'app-check' });
	harness.sent.length = 0;

	harness.reply({ success: false, error: 'Session expired' });
	await assert.rejects(deploy.handle(syncCtx(), { projectPath: 'app-check' }), (e: any) =>
		e.code === 'E_CONFIRM_REQUIRED' && /Could not check testinst/.test(e.message) && /Session expired/.test(e.message) && e.details?.checkFailed === true);
	assert.ok(!harness.sent.some((m) => m.action === 'deployAppPackage'), 'no deploy was sent');

	harness.reply({ success: false, error: 'Session expired' });
	harness.reply(installed);
	harness.reply(instancePackage('v1'));
	const forced = await deploy.handle(syncCtx(), { projectPath: 'app-check', force: true });
	assert.strictEqual(forced.installed, true);
	assert.strictEqual(forced.instanceChecked, false);
});

test('pull refuses outside git, lists with dryRun, and applies in a clean repository', async () => {
	const root = makeProject('app-pull');
	const file = `src/fluent/generated/sys_script_include_${'a'.repeat(32)}.xml`;

	harness.reply(instancePackage('p1'));
	await assert.rejects(pull.handle(syncCtx(), { projectPath: 'app-pull' }), (e: any) =>
		e.code === 'E_CONFIRM_REQUIRED' && /not in a git repository/.test(e.message));
	assert.ok(!fs.existsSync(path.join(root, file)), 'nothing was written');

	harness.reply(instancePackage('p1'));
	const dry = await pull.handle(syncCtx(), { projectPath: 'app-pull', dryRun: true });
	assert.deepStrictEqual(dry.changes, [{ path: file, status: 'added' }]);
	assert.deepStrictEqual(dry.applied, []);
	assert.ok(!fs.existsSync(path.join(root, file)));

	const git = (...args: string[]) => cp.execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
	git('init', '-q');
	git('add', '-A');
	git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
	harness.reply(instancePackage('p1'));
	const applied = await pull.handle(syncCtx(), { projectPath: 'app-pull' });
	assert.deepStrictEqual(applied.applied, [file]);
	assert.strictEqual(applied.firstPull, true);
	assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /p1/);
	assert.ok(fs.existsSync(path.join(root, '.snu', 'baseline', 'testinst')), 'the pull records the baseline');
	assert.ok(harness.sent.every((m) => m.initiatedBy === 'agent'), 'agent requests are marked as such');
});

test('pull needs a helper that can download', async () => {
	await assert.rejects(pull.handle(ctx(), { projectPath: 'app-pull' }), (e: any) => e.code === 'E_UNSUPPORTED_HOST');
});
