import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHarness, stubVscode } from './helpers/commandHarness';

const harness = createHarness();
stubVscode(harness.workspaceRoot);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordsCommands } = require('../agent/commands/records');

function command(name: string) {
	const handler = recordsCommands.find((c: any) => c.name === name);
	assert.ok(handler, `command ${name} is registered`);
	return handler;
}

const SCOPE_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const rest = (rows: any[], total = rows.length) => ({ success: true, status: 200, data: { result: rows }, pagination: { totalCount: String(total) } });
function schema(tables: string[]) {
	harness.reply(rest(tables.map(name => ({ name, 'super_class.name': '' }))));
	harness.reply(rest(tables.map(name => ({ name, element: name === 'sys_properties' ? 'value' : 'script', 'internal_type.name': name === 'sys_properties' ? 'string' : 'script', column_label: 'Script' }))));
}
const scriptRow = (n: number) => ({
	sys_id: n.toString(16).padStart(32, '0'),
	name: `Util${n}`,
	sys_name: `Util${n}`,
	'sys_scope.scope': 'x_acme_app',
	script: `var Util${n} = ${n};`,
});

test.afterEach(() => { harness.sent.length = 0; });
test.after(() => harness.cleanup());

test('pull_scope resolves the scope, discovers its tables, and pages every table to disk', async () => {
	const ctx = harness.context();
	// 1. scope lookup by name (scopes.json is empty at this point)
	harness.reply(rest([{ sys_id: SCOPE_ID, scope: 'x_acme_app', name: 'Acme App' }]));
	// 2. sys_metadata class discovery: one short page
	harness.reply(rest([
		...Array.from({ length: 103 }, () => ({ sys_class_name: 'sys_script_include' })),
		{ sys_class_name: 'sys_script' },
		{ sys_class_name: 'sys_properties' },
	]));
	schema(['sys_script', 'sys_script_include', 'sys_properties']);
	// 3. sys_script: one short page
	harness.reply(rest([{ sys_id: 'b'.repeat(32), name: 'Before insert', sys_name: 'Before insert', 'sys_scope.scope': 'x_acme_app', script: 'current.u_x = 1;', condition: '' }]));
	// 4. sys_script_include: a full page of 100 then a short page of 3
	harness.reply(rest(Array.from({ length: 100 }, (_, i) => scriptRow(i + 1)), 103));
	harness.reply(rest(Array.from({ length: 3 }, (_, i) => scriptRow(101 + i)), 103));

	const result = await command('pull_scope').handle(ctx, { scope: 'x_acme_app' });

	assert.deepStrictEqual(result.scope, { name: 'x_acme_app', sys_id: SCOPE_ID });
	assert.strictEqual(result.complete, true);
	assert.strictEqual(result.totals.tables, 2);
	assert.strictEqual(result.totals.records, 104);
	assert.deepStrictEqual(result.skippedTables, [{ table: 'sys_properties', records: 1, reason: 'no_scriptable_fields' }]);
	const inc = result.tables.find((t: any) => t.table === 'sys_script_include');
	assert.strictEqual(inc.matchedRecords, 103);
	assert.strictEqual(inc.truncated, false);
	assert.strictEqual(inc.records, undefined, 'record lists stay out of the response by default');

	// the include pull went out as two pages with a moving offset
	const includePulls = harness.sent.filter((m) => m.endpoint === '/api/now/table/sys_script_include');
	assert.deepStrictEqual(includePulls.map((m) => m.queryParams.sysparm_offset), ['0', '100']);
	assert.ok(includePulls[0].queryParams.sysparm_query.includes(`sys_scope=${SCOPE_ID}`));

	// files landed in the canonical layout and the map tracks them
	const folder = path.join(harness.instanceFolder, 'x_acme_app', 'sys_script_include');
	assert.ok(fs.existsSync(path.join(folder, 'Util103.script.js')));
	const map = JSON.parse(fs.readFileSync(path.join(folder, '_map.json'), 'utf8'));
	assert.strictEqual(Object.keys(map).length, 103);
	// the resolved scope was remembered for later calls
	const scopes = JSON.parse(fs.readFileSync(path.join(harness.instanceFolder, 'scopes.json'), 'utf8'));
	assert.strictEqual(scopes.x_acme_app, SCOPE_ID);
});

test('pull_scope honours the tables filter and the per-table limit', async () => {
	const ctx = harness.context();
	// scopes.json now knows the scope: no sys_scope lookup, discovery first
	harness.reply(rest([
		{ sys_class_name: 'sys_script_include' },
		{ sys_class_name: 'sys_script' },
	]));
	schema(['sys_script', 'sys_script_include']);
	// only sys_script_include is pulled, and only one page of `limit` records
	harness.reply(rest(Array.from({ length: 5 }, (_, i) => scriptRow(200 + i)), 10));

	const result = await command('pull_scope').handle(ctx, { scope: 'x_acme_app', tables: ['sys_script_include', 'sys_ui_action'], limit: 5 });

	assert.strictEqual(harness.sent[0].endpoint, '/api/now/table/sys_metadata');
	assert.strictEqual(result.tables.length, 1);
	assert.strictEqual(result.tables[0].truncated, true);
	assert.strictEqual(harness.sent.find(m => m.endpoint === '/api/now/table/sys_script_include').queryParams.sysparm_limit, '5');
	assert.ok(result.warnings.some((w: string) => w.startsWith('sys_script_include: stopped at the per-table limit')));
	assert.ok(result.warnings.some((w: string) => w.startsWith('sys_ui_action: no records')));
});

test('pull_scope refuses global and malformed scopes without touching the browser', async () => {
	const ctx = harness.context();
	for (const scope of ['global', 'x acme', '']) {
		await assert.rejects(command('pull_scope').handle(ctx, { scope }), (e: any) => e.code === 'E_INVALID_PARAMS');
	}
	assert.strictEqual(harness.sent.length, 0);
});

test('pull_records still pulls a single page and now passes an explicit offset', async () => {
	const ctx = harness.context();
	harness.reply(rest([scriptRow(900)]));
	const result = await command('pull_records').handle(ctx, { table: 'sys_script_include', query: 'nameSTARTSWITHUtil', limit: 10 });
	assert.strictEqual(result.pulledRecords, 1);
	assert.strictEqual(harness.sent[0].queryParams.sysparm_offset, '0');
	assert.strictEqual(harness.sent[0].queryParams.sysparm_limit, '10');
});

test('unreadable script fields preserve local files while an explicit empty value clears them', async () => {
	const ctx = harness.context();
	const row = scriptRow(950);
	const params = { table: 'sys_script_include', query: `sys_id=${row.sys_id}`, limit: 1 };
	harness.reply(rest([row]));
	await command('pull_records').handle(ctx, params);
	const file = path.join(harness.instanceFolder, 'x_acme_app/sys_script_include/Util950.script.js');
	const { script, ...unreadable } = row;
	harness.reply(rest([unreadable]));
	const result = await command('pull_records').handle(ctx, params);
	assert.strictEqual(result.skippedUnreadable, 1);
	assert.strictEqual(fs.readFileSync(file, 'utf8'), script);
	harness.reply(rest([{ ...row, script: '' }]));
	await command('pull_records').handle(ctx, params);
	assert.strictEqual(fs.readFileSync(file, 'utf8'), '');
});
