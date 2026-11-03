import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runNowSdk } from '../NowSdkBuild';

test('SDK execution passes paths and shell metacharacters as literal arguments', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu sdk & space-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const bin = path.join(root, 'node_modules', '@servicenow', 'sdk', 'bin');
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, 'index.js'), 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));');
	const args = ['transform', '--from', 'C:\\Users\\Jane Doe\\Temp\\package', '$(echo injected)', '`echo injected`', '%TEMP%', '!TEMP!', 'a&b|c;d', 'a"b', 'trailing\\', 'line\nbreak', ''];
	const chunks: string[] = [];
	const output = await runNowSdk(root, args, (text) => chunks.push(text));
	assert.deepEqual(JSON.parse(output), { args, cwd: fs.realpathSync(root) });
	assert.ok(chunks.includes(output));
});

test('SDK execution reports missing installs and failed commands', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-sdk-failure-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	assert.throws(() => runNowSdk(root, ['build']), /npm install/);
	const bin = path.join(root, 'node_modules', '@servicenow', 'sdk', 'bin');
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, 'index.js'), 'console.error("build failed detail"); process.exit(7);');
	await assert.rejects(runNowSdk(root, ['build']), /now-sdk build failed \(exit 7\).*\nbuild failed detail/);
});
