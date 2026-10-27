import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';

test('standalone reports one reviewed command and ignores result polls and internal REST calls', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-usage-'));
    fs.mkdirSync(path.join(cwd, 'usageinst'));
    fs.writeFileSync(path.join(cwd, 'usageinst', '_settings.json'), JSON.stringify({ url: 'https://usageinst.service-now.com', g_ck: 'private token' }));
    const pending = new PendingRegistry();
    const sent: any[] = [];
    const bridge = new StandaloneWsBridge(0, pending);
    Object.assign(bridge, {
        hasBrowserClient: () => true,
        getHelperState: () => ({ capabilities: { commandReview: 1, instanceSecurityGates: 1, usageMetrics: 1, usageSession: 'usage-session' } }),
        getInstanceGate: () => 'approve', registerReview() {}, cancelReview() {},
        sendToBrowser: (message: any) => sent.push(message),
    });
    const dispatcher = new StandaloneDispatcher({ cwd, wsBridge: bridge, pending, cliFlags: { backgroundScripts: true } });
    try {
        const first = await dispatcher.dispatch({ id: 'one', instance: 'usageinst', command: 'run_background_script', params: { script: 'private script' } });
        assert.equal(first.code, 'E_REVIEW_PENDING');
        assert.equal(sent.filter(e => e.action === 'agentUsage').length, 0);
        const review = sent.find(e => e.action === 'reviewRequest');
        pending.resolve(review.agentRequestId, { success: true, output: 'private output' });
        await new Promise(resolve => setImmediate(resolve));
        for (let i = 0; i < 3; i++) await dispatcher.dispatch({ id: 'poll' + i, command: 'get_review_result', params: { reviewId: review.reviewId } });
        const events = sent.filter(e => e.action === 'agentUsage');
        assert.equal(events.length, 1);
        assert.equal(events[0].host, 'standalone');
        assert.equal(events[0].outcome, 'success');
        assert.ok(!JSON.stringify(events).includes('private'));
    } finally { pending.rejectAll('E_CANCELLED', 'test done'); fs.rmSync(cwd, { recursive: true, force: true }); }
});
