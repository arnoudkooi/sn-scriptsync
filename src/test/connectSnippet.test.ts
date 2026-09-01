import test from 'node:test';
import assert from 'node:assert';
import { createHarness, stubVscode } from './helpers/commandHarness';

const harness = createHarness();
stubVscode(harness.workspaceRoot);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AGENT_CONNECT_SNIPPET, AGENT_CONNECT_SNIPPET_SERVED } = require('../agent/transport/http');

test.after(() => harness.cleanup());

test('the pasteable snippet tells an agent how to install and start', () => {
	assert.match(AGENT_CONNECT_SNIPPET, /@snutils\/snu/);
	assert.match(AGENT_CONNECT_SNIPPET, /snu context --json/, 'names a first command, not just a package');
	assert.match(AGENT_CONNECT_SNIPPET, /npx -y @snutils\/snu@latest setup/);
});

test('the pasteable snippet points at the raw API docs', () => {
	assert.match(AGENT_CONNECT_SNIPPET, /\/api\/instructions/);
});

test('the served copy does NOT point at the page it is served on', () => {
	// This text is prepended to the /api/instructions response itself, so a
	// pointer back to /api/instructions sends the reader where they already are.
	assert.ok(
		!AGENT_CONNECT_SNIPPET_SERVED.includes('/api/instructions'),
		'the copy served at /api/instructions must not link to /api/instructions'
	);
	assert.match(AGENT_CONNECT_SNIPPET_SERVED, /documented below/, 'it points down the page instead');
});

test('both copies carry the same setup guidance', () => {
	for (const line of ['@snutils/snu', 'npx -y @snutils/snu@latest setup', 'snu context --json']) {
		assert.ok(AGENT_CONNECT_SNIPPET.includes(line), `pasteable copy: ${line}`);
		assert.ok(AGENT_CONNECT_SNIPPET_SERVED.includes(line), `served copy: ${line}`);
	}
});

test('neither copy leaks a token or tells an agent to read one out', () => {
	// The snippet is pasted into config files and shown in the browser; the
	// token belongs in the port file the core docs describe, not here.
	for (const snippet of [AGENT_CONNECT_SNIPPET, AGENT_CONNECT_SNIPPET_SERVED]) {
		assert.ok(!/X-Agent-Token/i.test(snippet));
		assert.ok(!/[0-9a-f]{24,}/i.test(snippet));
	}
});
