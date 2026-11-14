import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createHarness } from './helpers/commandHarness';

const harness = createHarness();
// Install the vscode stub before loading the command module.
const { recordsCommands } = require('../agent/commands/records');
const schema = recordsCommands.find((c: any) => c.name === 'get_table_metadata');

test.beforeEach(() => {
	harness.sent.length = 0;
	fs.writeFileSync(path.join(harness.instanceFolder, '_settings.json'),
		JSON.stringify({ name: 'testinst', url: 'https://testinst.service-now.com', g_ck: 'token' }));
});
test.after(() => harness.cleanup());

const columns = {
	requested_for: { name: 'requested_for', label: 'Requested for', type: 'reference', internal_type: 'reference', reference: 'sys_user', mandatory: false, read_only: false, max_length: 32 },
	origin: { name: 'origin', label: 'Origin', type: 'choice', internal_type: 'string', mandatory: true, read_only: false, max_length: 40,
		choices: [{ label: '-- None --', value: '' }, { label: 'Portal', value: 'portal' }] },
};

test('schema: the VS Code host keeps columns as before and adds the normalized fields list', async () => {
	harness.reply({ success: true, result: { columns } });
	const result = await schema.handle(harness.context(), { table: 'x_acme_line' });
	assert.deepEqual(result.columns, columns, 'existing callers read columns unchanged');
	assert.deepEqual(result.fields, [
		{ name: 'requested_for', label: 'Requested for', internalType: 'reference', type: 'reference', reference: 'sys_user', mandatory: false, readOnly: false, maxLength: 32 },
		{ name: 'origin', label: 'Origin', internalType: 'string', type: 'string', mandatory: true, readOnly: false, maxLength: 40, choiceCount: 1 },
	]);
	assert.equal(harness.sent.at(-1).action, 'requestTableStructure');

	harness.reply({ success: true, result: { columns } });
	const withChoices = await schema.handle(harness.context(), { table: 'x_acme_line', choices: true });
	assert.deepEqual(withChoices.fields[1].choices, [{ value: 'portal', label: 'Portal' }]);
});

test('schema: a malformed table name is refused before anything is sent', async () => {
	await assert.rejects(schema.handle(harness.context(), { table: 'sys_user/../x' }), { code: 'E_INVALID_PARAMS' });
	assert.equal(harness.sent.length, 0);
});
