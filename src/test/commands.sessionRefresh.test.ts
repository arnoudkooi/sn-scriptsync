import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createHarness } from './helpers/commandHarness';

const harness = createHarness();
// Install the vscode stub before loading the command module.
const { runBackgroundScript } = require('../agent/commands/_shared');
const instance = { name: 'testinst', url: 'https://testinst.service-now.com', g_ck: 'old-token' };
const settingsPath = path.join(harness.instanceFolder, '_settings.json');

test.beforeEach(() => fs.writeFileSync(settingsPath, JSON.stringify(instance)));
test.afterEach(() => { harness.sent.length = 0; });
test.after(() => harness.cleanup());

function refreshingContext() {
	return harness.context({ sendToBrowser: (message: any) => {
		harness.sent.push(message);
		if (message.action === 'runSlashCommand') {
			fs.writeFileSync(settingsPath, JSON.stringify({ ...instance, g_ck: 'fresh-token' }));
		}
	} });
}

for (const rejection of [
	{ success: true, output: 'not authorized' },
	{ success: false, code: 'E_UNAUTHORIZED', error: 'Session rejected' },
]) {
	test(`helper refusal stops ${rejection.success ? 'text' : 'structured'} unauthorized retry immediately`, { timeout: 1500 }, async () => {
		harness.reply(rejection);
		harness.reply({ success: false, code: 'E_TOKEN_EXPIRED', error: 'Run /token manually' });
		// Even an unrelated settings update cannot override the helper's refusal.
		await assert.rejects(runBackgroundScript(refreshingContext(), instance, 'gs.info("test");'), { code: 'E_UNAUTHORIZED' });
		assert.deepEqual(harness.sent.map(message => message.action), ['agentRunBackgroundScript', 'runSlashCommand']);
	});
}

test('an allowed refresh retries once with the fresh token', async () => {
	harness.reply({ success: true, output: 'not authorized' });
	harness.reply({ success: true });
	harness.reply({ success: true, output: 'completed' });
	assert.equal(await runBackgroundScript(refreshingContext(), instance, 'gs.info("test");'), 'completed');
	assert.deepEqual(harness.sent.map(message => message.action), ['agentRunBackgroundScript', 'runSlashCommand', 'agentRunBackgroundScript']);
	assert.equal(harness.sent[1].command, '/token');
	assert.equal(harness.sent[1].url, instance.url + '/*');
	assert.equal(harness.sent[2].instance.g_ck, 'fresh-token');
});

test('a repeated unauthorized response does not start another refresh', async () => {
	harness.reply({ success: true, output: 'not authorized' });
	harness.reply({ success: true });
	harness.reply({ success: true, output: 'not authorized' });
	await assert.rejects(runBackgroundScript(refreshingContext(), instance, 'gs.info("test");'), { code: 'E_UNAUTHORIZED' });
	assert.equal(harness.sent.filter(message => message.action === 'runSlashCommand').length, 1);
	assert.equal(harness.sent.filter(message => message.action === 'agentRunBackgroundScript').length, 2);
});

test('a script failure unrelated to authentication is never replayed', async () => {
	harness.reply({ success: false, code: 'E_INTERNAL', error: 'Script failed' });
	await assert.rejects(runBackgroundScript(harness.context(), instance, 'gs.info("test");'), { code: 'E_INTERNAL' });
	assert.equal(harness.sent.length, 1);
});

test('an instance without a URL is never refreshed with a wildcard', async () => {
	harness.reply({ success: true, output: 'not authorized' });
	await assert.rejects(runBackgroundScript(refreshingContext(), { ...instance, url: '' }, 'gs.info("test");'), { code: 'E_UNAUTHORIZED' });
	assert.deepEqual(harness.sent.map(message => message.action), ['agentRunBackgroundScript']);
});
