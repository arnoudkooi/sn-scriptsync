import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { WebSocket } from 'ws';
import { publicCapabilities, usageStatus } from '../server/usageMetrics.js';
import { buildDoctorReport, formatDoctorReport } from '../cli/doctor.js';

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


test('usage status: three modes, an older helper, and unknown instead of off', () => {
    assert.deepEqual(usageStatus({ usageMode: 'collect-and-share' }), { collection: 'on', sharingPreference: 'on' });
    assert.deepEqual(usageStatus({ usageMode: 'collect' }), { collection: 'on', sharingPreference: 'off' });
    assert.deepEqual(usageStatus({ usageMode: 'off' }), { collection: 'off', sharingPreference: 'off' });
    assert.deepEqual(usageStatus({ usageMetrics: 1, usageSession: 'abc' }), { collection: 'on', sharingPreference: 'unknown' });
    for (const caps of [undefined, null, {}, { usageMetrics: 1, usageSession: '' }, { usageMode: 'maybe' }])
        assert.deepEqual(usageStatus(caps), { collection: 'unknown', sharingPreference: 'unknown' });
    assert.deepEqual(publicCapabilities({ protocolVersion: 1, usageMetrics: 1, usageSession: 'abc', usageMode: 'off' }), { protocolVersion: 1, usageMetrics: 1 });
});

test('standalone: the helper\'s usage setting follows changes without a reconnect and never shows the session id', async () => {
    const pending = new PendingRegistry();
    const bridge = new StandaloneWsBridge(0, pending);
    const port = await bridge.start();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-usage-status-'));
    const dispatcher = new StandaloneDispatcher({ cwd, wsBridge: bridge, pending, cliFlags: {} } as any);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const SESSION = '5f0c2b8e-usage-session-must-not-leak';
    const snapshot = async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        const caps: any = await dispatcher.dispatch({ id: 'c', command: 'get_capabilities', params: {} });
        const conn: any = await dispatcher.dispatch({ id: 'k', command: 'check_connection', params: {} });
        assert.ok(!JSON.stringify(caps).includes(SESSION) && !JSON.stringify(conn).includes(SESSION), 'session id leaked');
        assert.deepEqual(caps.result.usage, conn.result.usage);
        return caps.result.usage;
    };
    try {
        await new Promise<void>(resolve => ws.on('open', () => resolve()));
        ws.send(JSON.stringify({ action: 'helperBuildInfo', capabilities: { protocolVersion: 1, usageMetrics: 1 } }));
        assert.deepEqual(await snapshot(), { collection: 'unknown', sharingPreference: 'unknown' }, 'nothing reported yet');
        ws.send(JSON.stringify({ action: 'helperUsageInfo', usageSession: SESSION, usageMode: 'collect-and-share' }));
        assert.deepEqual(await snapshot(), { collection: 'on', sharingPreference: 'on' });
        ws.send(JSON.stringify({ action: 'helperUsageInfo', usageSession: SESSION, usageMode: 'collect' }));
        assert.deepEqual(await snapshot(), { collection: 'on', sharingPreference: 'off' });
        ws.send(JSON.stringify({ action: 'helperUsageInfo', usageSession: '', usageMode: 'off' }));
        assert.deepEqual(await snapshot(), { collection: 'off', sharingPreference: 'off' });
        // An older helper sends only the session.
        ws.send(JSON.stringify({ action: 'helperUsageInfo', usageSession: SESSION }));
        assert.deepEqual(await snapshot(), { collection: 'on', sharingPreference: 'unknown' });
        ws.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.deepEqual(await snapshot(), { collection: 'unknown', sharingPreference: 'unknown' }, 'a closed helper is unknown, not off');
    } finally {
        ws.close();
        pending.rejectAll('E_CANCELLED', 'test done');
        await bridge.close();
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('doctor: shows the usage setting, and unknown without a helper', () => {
    const base = { cliVersion: '0.6.6', platform: 'darwin', nodeVersion: 'v22', cwd: '/tmp', descriptors: [], listeners: [], instances: [] };
    const on = formatDoctorReport(buildDoctorReport({ ...base, health: { status: 'success' }, capabilities: { usage: { collection: 'on', sharingPreference: 'off' } } } as any));
    assert.match(on, /Usage data\s+collection on, sharing preference off/);
    assert.match(on, /SN Utils settings > Usage Data/);
    const none = buildDoctorReport(base as any);
    assert.deepEqual(none.usage, { collection: 'unknown', sharingPreference: 'unknown' });
    assert.match(formatDoctorReport(none), /collection unknown, sharing preference unknown/);
});
