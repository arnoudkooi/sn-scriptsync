import test from 'node:test';
import assert from 'node:assert';
import {
	registerReview, settleReview, hasReview, waitForReview, markReviewRunning, isReviewRunning,
} from '../agent/reviewRegistry';

// Issue #162: the entry was deleted a fixed time after it was created, so an
// approved command that ran long (sdk_deploy) lost its result before it settled.

test('an approved command that runs past the old creation-based expiry keeps its entry', (t) => {
	(t.mock.timers.enable as any)({ apis: ['setTimeout'] });
	registerReview('rev_long', 'req_1', 'sdk_deploy', 300_000);
	markReviewRunning('rev_long');
	assert.strictEqual(isReviewRunning('rev_long'), true);

	t.mock.timers.tick(20 * 60_000); // well past 5 + 10 min
	assert.strictEqual(hasReview('rev_long'), true);

	settleReview('rev_long', { id: 'req_1', command: 'sdk_deploy', status: 'success', result: { ok: true }, timestamp: 0 } as any);
	assert.strictEqual(isReviewRunning('rev_long'), false);

	t.mock.timers.tick(9 * 60_000);
	assert.strictEqual(hasReview('rev_long'), true, 'result stays collectable after it settles');
	t.mock.timers.tick(2 * 60_000);
	assert.strictEqual(hasReview('rev_long'), false, 'and is dropped ~10 min after settling');
});

test('a settled result is returned by waitForReview', async () => {
	registerReview('rev_quick', 'req_2', 'run_background_script', 300_000);
	settleReview('rev_quick', { id: 'req_2', command: 'run_background_script', status: 'success', result: { output: 'x' }, timestamp: 0 } as any);
	const resp = await waitForReview('rev_quick', 10);
	assert.deepStrictEqual(resp?.result, { output: 'x' });
});
