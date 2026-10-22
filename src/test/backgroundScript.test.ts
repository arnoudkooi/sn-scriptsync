import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScriptOutput, retryAfterTokenRefresh, scriptNotStarted, scriptResult } from '../agent/backgroundScript';
import { NOT_STARTED_VECTORS, SCRIPT_OUTPUT_VECTORS } from '../agent/backgroundScriptVectors';

for (const vector of SCRIPT_OUTPUT_VECTORS) {
	test(`script output: ${vector.name}`, () => {
		const parsed = parseScriptOutput(vector.output);
		assert.equal(parsed.stdout, vector.expect.stdout);
		assert.equal(parsed.executionId, vector.expect.executionId);
		assert.equal(parsed.status, vector.expect.status);
		if (vector.expect.warnings) assert.deepEqual(parsed.warnings, vector.expect.warnings);
		if (vector.expect.errors) assert.deepEqual(parsed.errors, vector.expect.errors);
		if (vector.expect.logLines) assert.deepEqual(parsed.logLines, vector.expect.logLines);
	});
}

for (const vector of NOT_STARTED_VECTORS) {
	test(`script retry: ${vector.name}`, () => {
		assert.equal(scriptNotStarted(vector.reply), vector.notStarted);
		assert.equal(retryAfterTokenRefresh(vector.reply), vector.retry);
	});
}

test('script result keeps the raw output byte for byte next to the parsed fields', () => {
	const raw = '<PRE>*** Script: SNU_DELAPP:OK:App:x_app:3<BR/></PRE>';
	const result = scriptResult(raw);
	assert.equal(result.executed, true);
	assert.equal(result.output, raw);
	assert.equal(result.stdout, 'SNU_DELAPP:OK:App:x_app:3');
	assert.deepEqual(scriptResult(undefined).output, '');
});
