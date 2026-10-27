import test from 'node:test';
import assert from 'node:assert/strict';
import { beginUsage } from '../agent/usageMetrics';

test('one final result, no polling, staged writes, payloads or duplicate callbacks', () => {
    const events: any[] = [];
    const finish = beginUsage('update_records', false, 'vscode', () => 'session', e => events.push(e as any));
    finish({ status: 'error', code: 'E_REVIEW_PENDING' });
    finish({ status: 'success', result: { staged: true } });
    assert.equal(events.length, 0);
    finish({ status: 'error', code: 'E_PARTIAL_FAILURE', details: {
        counts: { succeeded: 3, failed: 2, notAttempted: 1, unknown: 1 },
        rows: [{ sys_id: 'secret', script: 'private code' }],
    } });
    finish({ status: 'success' });
    assert.deepEqual(events, [{ action: 'agentUsage', usageSession: 'session', host: 'vscode',
        command: 'update_records', outcome: 'error', rows: { succeeded: 3, failed: 2, not_attempted: 1, unknown: 1 } }]);
    for (const command of ['get_review_result', 'get_batch_result', 'check_connection', 'unknown_secret'])
        beginUsage(command, false, 'vscode', () => 'session', e => events.push(e as any))({ status: 'success' });
    assert.equal(events.length, 1);
});

test('off, old helpers, session replacement and send failures cannot affect work', () => {
    const events: any[] = [];
    let session = 'one';
    const finish = beginUsage('query_records', false, 'vscode', () => session, e => events.push(e as any));
    session = 'two'; finish({ status: 'success' });
    beginUsage('query_records', false, 'vscode', () => '', e => events.push(e as any))({ status: 'success' });
    assert.equal(events.length, 0);
    assert.doesNotThrow(() => beginUsage('query_records', false, 'vscode', () => 's', () => { throw new Error('socket closed'); })({ status: 'success' }));
});

test('refusals, cancellations and dry runs have separate outcomes', () => {
    const events: any[] = [];
    for (const [dryRun, response] of [
        [false, { status: 'error', code: 'E_DISABLED' }],
        [false, { status: 'error', code: 'E_USER_REJECTED' }],
        [true, { status: 'success', result: { counts: { succeeded: 4 } } }],
        [false, { status: 'success', result: { dryRun: true, counts: { succeeded: 4 } } }],
    ] as const) beginUsage('create_records', dryRun, 'standalone', () => 's', e => events.push(e as any))(response);
    assert.deepEqual(events.map(e => e.outcome), ['blocked', 'cancelled', 'dry_run', 'dry_run']);
    assert.deepEqual(events[2].rows, {});
    assert.deepEqual(events[3].rows, {});
});
