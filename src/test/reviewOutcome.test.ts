import test from 'node:test';
import assert from 'node:assert';
import { reviewExecutionFailure } from '../agent/reviewOutcome';

test('approved execution failures never default to E_USER_REJECTED', () => {
	const failure = reviewExecutionFailure({
		success: false,
		error: 'Operation Failed',
		status: 403,
		detail: 'Cross-scope access denied by ServiceNow',
		data: { error: { message: 'Operation Failed' } },
	});

	assert.strictEqual(failure.code, 'E_COMMAND_FAILED');
	assert.strictEqual(failure.message, 'Operation Failed');
	assert.deepStrictEqual(failure.details, {
		status: 403,
		detail: 'Cross-scope access denied by ServiceNow',
		response: { error: { message: 'Operation Failed' } },
	});
});

test('a legacy E_USER_REJECTED execution label is corrected after approval', () => {
	const failure = reviewExecutionFailure({
		success: false,
		code: 'E_USER_REJECTED',
		error: 'Operation Failed',
	});
	assert.strictEqual(failure.code, 'E_COMMAND_FAILED');
});

test('an explicit helper execution code and details are preserved', () => {
	const failure = reviewExecutionFailure({
		success: false,
		code: 'E_ACL',
		error: { message: 'Forbidden', detail: 'ACL denied delete' },
		details: { reviewId: 'rev_1' },
	});

	assert.strictEqual(failure.code, 'E_ACL');
	assert.strictEqual(failure.message, 'Forbidden');
	assert.strictEqual(failure.details.reviewId, 'rev_1');
	assert.strictEqual(failure.details.detail, 'ACL denied delete');
});
