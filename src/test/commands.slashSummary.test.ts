import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/commandHarness';

const harness = createHarness();
const { browserCommands } = require('../agent/commands/browser');
const command = browserCommands.find((c: any) => c.name === 'run_slash_command');
test.after(() => harness.cleanup());

test('run_slash_command waits for completion and returns the summary unchanged', async () => {
    let finish: (value: any) => void = () => {};
    let finished = false;
    const pending = new Promise(resolve => { finish = resolve; });
    const ctx = harness.context({ waitForBrowserResponse: (_id: string, timeout: number) => {
        assert.equal(timeout, 70_000);
        return pending;
    } });
    const running = command.handle(ctx, { command: '/rnd -a', tabId: 42 }).then((result: any) => { finished = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    const sent = harness.sent.at(-1)!;
    assert.equal(sent.action, 'runSlashCommand');
    assert.equal(sent.tabId, 42);
    assert.equal(sent.autoRun, true);
    const summary = { status: 'cancelled', table: 'incident', sysId: 'abc', filled: 2, skipped: 1, pending: 3 };
    finish({ success: true, command: '/rnd -a', tabId: 42, summary });
    const result = await running;
    assert.deepEqual(result.summary, summary);
    assert.equal(result.executed, true);
    assert.equal(result.status, 'cancelled');
});

test('older helpers and command previews preserve their acknowledgement response', async () => {
    harness.reply({ success: true, command: '/rnd', tabId: 42, autoRun: false });
    const result = await command.handle(harness.context(), { command: '/rnd', autoRun: false });
    assert.deepEqual(result, { executed: true, status: 'dispatched', slashCommand: '/rnd', tabId: 42, autoRun: false });
});

test('helper delivery failures are errors instead of executed true', async () => {
    harness.reply({ success: false, code: 'E_TIMEOUT', error: 'Page did not respond in time' });
    await assert.rejects(command.handle(harness.context(), { command: '/rnd' }), (err: any) => err.code === 'E_TIMEOUT');
});

test('Workspace /rnd license denial remains an explicit Agent API error', async () => {
    harness.reply({ success: false, code: 'E_PRO_REQUIRED', error: 'Workspace requires Pro' });
    await assert.rejects(command.handle(harness.context(), { command: '/rnd', tabId: 42 }),
        (err: any) => err.code === 'E_PRO_REQUIRED' && err.details?.status === 'error');
});

test('/token with a tab target does not receive a conflicting default URL wildcard', async () => {
    harness.reply({ success: true, status: 'completed', command: '/token', tabId: 42 });
    const result = await command.handle(harness.context(), { command: 'token', tabId: 42 });
    assert.equal(harness.sent.at(-1)?.url, undefined);
    assert.equal(harness.sent.at(-1)?.tabId, 42);
    assert.equal(result.status, 'completed');
});


test('command-specific summaries and uniform completion status reach the agent', async () => {
    for (const [name, summary] of [
        ['/tn', { status: 'completed', state: 'enabled', enabled: true, total: 2, visible: 2 }],
        ['/bg', { status: 'completed', url: 'https://example.service-now.com/sys.scripts.modern.do', tabId: 99 }],
        ['/token', { status: 'completed', origin: 'https://example.service-now.com', refreshed: true }],
        ['/rnd', { status: 'error', reason: 'No active form found' }],
    ] as const) {
        harness.reply({ success: true, command: name, tabId: 42, status: summary.status, summary });
        const result = await command.handle(harness.context(), { command: name, tabId: 42 });
        assert.deepEqual(result.summary, summary);
        assert.equal(result.status, summary.status);
    }
});
