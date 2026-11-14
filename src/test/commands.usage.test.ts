import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/commandHarness';

const harness = createHarness();
// Install the vscode stub before loading the command module.
const { connectionCommands } = require('../agent/commands/connection');
const capabilities = connectionCommands.find((c: any) => c.name === 'get_capabilities');
test.after(() => harness.cleanup());

const SESSION = 'usage-session-must-not-leak';
const reply = (extra: Record<string, any> = {}) => ({ success: true, tier: 'pro', proFeatures: true, cdp: {}, capabilities: { protocolVersion: 1, usageSession: SESSION }, instanceGates: {}, ...extra });

test('get_capabilities (VS Code host): the helper\'s mode decides; the session id never shows', async () => {
	for (const [mode, expected] of [
		['collect-and-share', { collection: 'on', sharingPreference: 'on' }],
		['collect', { collection: 'on', sharingPreference: 'off' }],
		['off', { collection: 'off', sharingPreference: 'off' }],
	] as const) {
		harness.reply(reply({ usageMode: mode }));
		const result = await capabilities.handle(harness.context(), {});
		assert.deepEqual(result.usage, expected);
		assert.ok(!JSON.stringify(result).includes(SESSION));
	}
});

test('get_capabilities (VS Code host): an older helper falls back to what helperUsageInfo told the host', async () => {
	harness.reply(reply());
	const latest = { capabilities: { usageMetrics: 1, usageSession: SESSION, usageMode: 'collect' } };
	const changed = await capabilities.handle(harness.context({ getHelperBuildInfo: () => latest }), {});
	assert.deepEqual(changed.usage, { collection: 'on', sharingPreference: 'off' });

	harness.reply(reply());
	const sessionOnly = await capabilities.handle(harness.context({ getHelperBuildInfo: () => ({ capabilities: { usageMetrics: 1, usageSession: SESSION } }) }), {});
	assert.deepEqual(sessionOnly.usage, { collection: 'on', sharingPreference: 'unknown' });

	harness.reply(reply());
	const nothing = await capabilities.handle(harness.context({ getHelperBuildInfo: () => null }), {});
	assert.deepEqual(nothing.usage, { collection: 'unknown', sharingPreference: 'unknown' });
});
