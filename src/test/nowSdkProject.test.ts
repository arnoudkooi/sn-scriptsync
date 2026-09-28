import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	findNowSdkProjectRoot, findNowSdkProjects, findNewestZip, listFlowRecordIds, parsePackOutput,
	readDeployLink, readNowSdkProject, resolveNowSdkProjectRoot, writeDeployLink, NowSdkProjectError,
	assertSupportedProject, assertSupportedSdk, isPathInside,
} from '../NowSdkProject';
import { summarizeDeployResult } from '../NowSdkBuild';

const SCOPE_ID = 'f64ef56e39704a9e80aee2ece02d22e1';

function makeProject(config: any = {}, pkg: any = { version: '0.0.1' }): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-nowsdk-'));
	fs.writeFileSync(path.join(root, 'now.config.json'), JSON.stringify({ scope: 'x_1849902_flspk', scopeId: SCOPE_ID, name: 'Spike', ...config }));
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
	fs.mkdirSync(path.join(root, 'src', 'fluent'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src', 'fluent', 'index.now.ts'), '');
	return root;
}

test('finds the project root from a nested source file', () => {
	const root = makeProject();
	assert.strictEqual(findNowSdkProjectRoot(path.join(root, 'src', 'fluent', 'index.now.ts')), root);
});

test('does not look above stopAt', () => {
	const root = makeProject();
	const inner = path.join(root, 'src');
	assert.strictEqual(findNowSdkProjectRoot(path.join(inner, 'fluent', 'index.now.ts'), inner), null);
	assert.strictEqual(findNowSdkProjectRoot(path.join(inner, 'fluent', 'index.now.ts'), root), root);
});

test('a file outside stopAt never matches', () => {
	const root = makeProject();
	const other = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-other-'));
	assert.strictEqual(findNowSdkProjectRoot(path.join(root, 'src', 'fluent', 'index.now.ts'), other), null);
});

test('reads scope, scopeId, version and default output folders', () => {
	const root = makeProject();
	const p = readNowSdkProject(root);
	assert.strictEqual(p.scope, 'x_1849902_flspk');
	assert.strictEqual(p.scopeId, SCOPE_ID);
	assert.strictEqual(p.version, '0.0.1');
	assert.strictEqual(p.appOutputDir, path.join(root, 'dist', 'app'));
	assert.strictEqual(p.packOutputDir, path.join(root, 'target'));
});

test('rejects invalid scope, scopeId, version and escaping output folders', () => {
	assert.throws(() => readNowSdkProject(makeProject({ scope: 'Bad Scope' })), NowSdkProjectError);
	assert.throws(() => readNowSdkProject(makeProject({ scopeId: 'nope' })), NowSdkProjectError);
	assert.throws(() => readNowSdkProject(makeProject({}, {})), NowSdkProjectError);
	assert.throws(() => readNowSdkProject(makeProject({ packOutputDir: '../../elsewhere' })), NowSdkProjectError);
});

test('lists flow and action ids from the build output', () => {
	const root = makeProject();
	const update = path.join(root, 'dist', 'app', 'update');
	fs.mkdirSync(update, { recursive: true });
	const flow = 'a'.repeat(32), action = 'b'.repeat(32);
	for (const f of [`sys_hub_flow_${flow}.xml`, `sys_hub_action_type_definition_${action}.xml`, `sys_script_include_${'c'.repeat(32)}.xml`, 'sys_hub_flow_short.xml']) {
		fs.writeFileSync(path.join(update, f), '');
	}
	assert.deepStrictEqual(listFlowRecordIds(path.join(root, 'dist', 'app')), { flows: [flow], actions: [action] });
	assert.deepStrictEqual(listFlowRecordIds(path.join(root, 'missing')), { flows: [], actions: [] });
});

test('parses the pack output and falls back to the newest zip', () => {
	assert.strictEqual(parsePackOutput('[now-sdk] Single artifact emitted as "/tmp/p/target/app_0_0_1.zip".'), '/tmp/p/target/app_0_0_1.zip');
	assert.strictEqual(parsePackOutput('nothing here'), null);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-zip-'));
	fs.writeFileSync(path.join(dir, 'old.zip'), 'x');
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(path.join(dir, 'old.zip'), past, past);
	fs.writeFileSync(path.join(dir, 'new.zip'), 'x');
	fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
	assert.strictEqual(findNewestZip(dir), path.join(dir, 'new.zip'));
	assert.strictEqual(findNewestZip(path.join(dir, 'missing')), null);
});

test('deploy link round-trips and keeps itself out of git', () => {
	const root = makeProject();
	assert.strictEqual(readDeployLink(root), null);
	writeDeployLink(root, { instance: 'dev436517', url: 'https://dev436517.service-now.com' });
	assert.deepStrictEqual(readDeployLink(root), { instance: 'dev436517', url: 'https://dev436517.service-now.com' });
	assert.strictEqual(fs.readFileSync(path.join(root, '.snu', '.gitignore'), 'utf8'), '*\n');
	fs.writeFileSync(path.join(root, '.snu', 'deploy.json'), JSON.stringify({ instance: 'x', url: 'javascript:alert(1)' }));
	assert.strictEqual(readDeployLink(root), null);
});

test('finds projects under a root and resolves the one an agent asks for', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-ws-'));
	const one = path.join(root, 'apps', 'one');
	const two = path.join(root, 'two');
	for (const dir of [one, two]) {
		fs.mkdirSync(path.join(dir, 'node_modules', 'nested'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'now.config.json'), '{}');
		fs.writeFileSync(path.join(dir, 'node_modules', 'nested', 'now.config.json'), '{}');
	}
	assert.deepStrictEqual(findNowSdkProjects(root), [one, two].sort());
	assert.strictEqual(resolveNowSdkProjectRoot(root, 'two'), fs.realpathSync(two));
	assert.strictEqual(resolveNowSdkProjectRoot(root, path.join(one, 'now.config.json')), fs.realpathSync(one));
	assert.throws(() => resolveNowSdkProjectRoot(root), /Several NOW SDK projects/);
	assert.throws(() => resolveNowSdkProjectRoot(root, '..'), NowSdkProjectError);
	assert.throws(() => resolveNowSdkProjectRoot(root, 'missing'), /not found/);
	fs.mkdirSync(path.join(root, 'plain'));
	assert.throws(() => resolveNowSdkProjectRoot(root, 'plain'), /No now.config.json/);
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-outside-'));
	fs.writeFileSync(path.join(outside, 'now.config.json'), '{}');
	fs.symlinkSync(outside, path.join(root, 'link'));
	assert.throws(() => resolveNowSdkProjectRoot(root, 'link'), /must be inside/);
	assert.strictEqual(resolveNowSdkProjectRoot(two), two);
});

test('summarizes installed, partial and failed deploys', () => {
	assert.deepStrictEqual(
		{ ...summarizeDeployResult({ success: true, flowActivation: null, durationMs: 5 }) },
		{ success: true, installed: true, partial: false, flowActivation: null, durationMs: 5 });
	const partial = summarizeDeployResult({ success: true, flowActivation: { ok: false, total: 2, succeeded: 1, failed: 1 } });
	assert.strictEqual(partial.partial, true);
	assert.strictEqual(partial.success, false);
	assert.strictEqual(partial.installed, true);
	const failed = summarizeDeployResult({ success: false, reason: 'Not allowing install of third party application', trackerUrl: 'https://x/t' });
	assert.strictEqual(failed.installed, false);
	assert.strictEqual(failed.error, 'Install failed');
	assert.strictEqual(failed.reason, 'Not allowing install of third party application');
	assert.strictEqual(summarizeDeployResult(null).installed, false);
});

test('refuses app types the SDK installs differently', () => {
	assert.doesNotThrow(() => assertSupportedProject(readNowSdkProject(makeProject())));
	assert.throws(() => assertSupportedProject(readNowSdkProject(makeProject({ type: 'configuration' }))), /configuration project/);
	assert.throws(() => assertSupportedProject(readNowSdkProject(makeProject({ installAs: 'store' }))), /Store app/);
	assert.throws(() => assertSupportedProject(readNowSdkProject(makeProject({ hostedPlugins: { x: 'global' } }))), /Store app/);
	assert.throws(() => assertSupportedProject(readNowSdkProject(makeProject({ scope: 'global', scopeId: 'global' }))), /global-scope/);
});

test('accepts ServiceNow SDK 4.1 up to 4.x only', () => {
	const withSdk = (version?: string) => {
		const root = makeProject();
		if (version) {
			fs.mkdirSync(path.join(root, 'node_modules', '@servicenow', 'sdk'), { recursive: true });
			fs.writeFileSync(path.join(root, 'node_modules', '@servicenow', 'sdk', 'package.json'), JSON.stringify({ version }));
		}
		return root;
	};
	assert.strictEqual(assertSupportedSdk(withSdk('4.13.0')), '4.13.0');
	assert.strictEqual(assertSupportedSdk(withSdk('4.1.0')), '4.1.0');
	assert.throws(() => assertSupportedSdk(withSdk('4.0.2')), /supports 4.1.0 up to 4.x/);
	assert.throws(() => assertSupportedSdk(withSdk('3.0.3')), /supports 4.1.0/);
	assert.throws(() => assertSupportedSdk(withSdk('5.0.0')), /supports 4.1.0/);
	assert.throws(() => assertSupportedSdk(withSdk()), /npm install/);
});

// A drive letter in a different case is the same folder on Windows: VS Code
// reports the workspace as c:\ while an agent may pass C:\ (issue #162).
test('isPathInside ignores drive-letter and path case on Windows only', () => {
	const w = path.win32;
	assert.ok(isPathInside('C:\\Users\\me\\ws\\app', 'c:\\Users\\me\\ws', w));
	assert.ok(isPathInside('c:\\users\\ME\\WS', 'C:\\Users\\me\\ws', w));
	assert.ok(!isPathInside('C:\\Users\\me\\wsx', 'c:\\Users\\me\\ws', w));
	assert.ok(!isPathInside('D:\\Users\\me\\ws', 'c:\\Users\\me\\ws', w));
	assert.ok(!isPathInside('c:\\Users\\me', 'c:\\Users\\me\\ws', w));
	const p = path.posix;
	assert.ok(isPathInside('/ws/app', '/ws', p));
	assert.ok(isPathInside('/ws/..app', '/ws', p), 'a folder named ..app is still inside');
	assert.ok(!isPathInside('/WS/app', '/ws', p), 'posix stays case-sensitive');
	assert.ok(!isPathInside('/wsx', '/ws', p));
	assert.ok(!isPathInside('/', '/ws', p));
});
