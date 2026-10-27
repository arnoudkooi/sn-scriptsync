import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, stubVscode } from './helpers/commandHarness';
const harness = createHarness('usageinst');
const stub = stubVscode(harness.workspaceRoot);
stub.extensions = { getExtension: () => ({ packageJSON: { version: 'test' } }) };
const { dispatchAgentCommand } = require('../agent/dispatcher');
const { setRuntime } = require('../agent/runtime');
const pending = require('../agent/pendingRegistry');
test.after(() => harness.cleanup());

test('dispatcher reports refusal once and reports an asynchronous review only after completion', async () => {
    let mode = 'off';
    const sent: any[] = [];
    setRuntime({ sendToBrowser: (event: any) => sent.push(event), hasBrowserClient: () => true,
        isServerRunning: () => true, log() {}, getInstanceGates: () => ({ backgroundScripts: mode }),
        getHelperBuildInfo: () => ({ capabilities: { instanceSecurityGates: 1, commandReview: 1, usageMetrics: 1, usageSession: 'usage-session' } }),
    });
    const request = { id: 'usage_1', instance: 'usageinst', command: 'run_background_script', params: { script: 'private script' } };
    assert.equal((await dispatchAgentCommand(request)).code, 'E_DISABLED');
    assert.equal(sent.filter(e => e.action === 'agentUsage').length, 1);
    assert.equal(sent[0].outcome, 'blocked');
    sent.length = 0; mode = 'approve';
    assert.equal((await dispatchAgentCommand({ ...request, id: 'usage_2' })).code, 'E_REVIEW_PENDING');
    assert.equal(sent.filter(e => e.action === 'agentUsage').length, 0);
    const review = sent.find(e => e.action === 'reviewRequest');
    pending.resolve(review.agentRequestId, { success: true, output: 'private output' });
    await new Promise(resolve => setImmediate(resolve));
    const events = sent.filter(e => e.action === 'agentUsage');
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'success');
    assert.ok(!JSON.stringify(events).includes('private'));
});
