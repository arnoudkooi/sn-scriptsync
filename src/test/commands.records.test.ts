import test from 'node:test';
import assert from 'node:assert';
import { createHarness, stubVscode } from './helpers/commandHarness';

// The stub must be installed before the command module is loaded, because that
// module imports `vscode` at require time.
const harness = createHarness();
stubVscode(harness.workspaceRoot);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordsCommands } = require('../agent/commands/records');

function command(name: string) {
	const handler = recordsCommands.find((c: any) => c.name === name);
	assert.ok(handler, `command ${name} is registered`);
	return handler;
}

const APP_SYS_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/** A sys_scope lookup reply, as the browser REST bridge would return it. */
function scopeLookupReply(rows: Array<{ sys_id: string; scope: string }>) {
	return { success: true, status: 200, data: { result: rows } };
}

test.afterEach(() => { harness.sent.length = 0; });
test.after(() => harness.cleanup());

// ---------------------------------------------------------------------------
// create_artifact — what actually goes on the wire.
// ---------------------------------------------------------------------------

test('create_artifact with no scope omits sys_scope entirely', async () => {
	// The incident: this used to send sys_scope:'global', overriding whichever
	// application was active. Omitting the field lets the instance decide.
	harness.reply({ success: true, newRecord: { sys_id: 'abc', name: 'MyUtils', tableName: 'sys_script_include', scope: 'x_acme_app' } });

	const result = await command('create_artifact').handle(harness.context(), {
		table: 'sys_script_include',
		fields: { name: 'MyUtils', script: '// x' },
	});

	const create = harness.sent.find((m) => m.action === 'createRecord');
	assert.ok(create, 'a createRecord message was sent');
	assert.ok(!('sys_scope' in create!.payload), 'sys_scope must be absent, not "global"');
	assert.strictEqual(create!.scope, undefined, 'no scope is sent when none was chosen');
	assert.strictEqual(result.scopeWasSpecified, false);
	assert.strictEqual(result.effectiveScope, 'x_acme_app', 'reports where it actually landed');
	assert.ok(Array.isArray(result.warnings) && /No scope was specified/.test(result.warnings[0]));
});

test('create_artifact with an explicit scope resolves it to a sys_id', async () => {
	harness.reply(scopeLookupReply([{ sys_id: APP_SYS_ID, scope: 'x_acme_app' }]));
	harness.reply({ success: true, newRecord: { sys_id: 'abc', name: 'MyUtils', tableName: 'sys_script_include', scope: 'x_acme_app' } });

	const result = await command('create_artifact').handle(harness.context(), {
		table: 'sys_script_include',
		fields: { name: 'MyUtils' },
		scope: 'x_acme_app',
	});

	const create = harness.sent.find((m) => m.action === 'createRecord');
	assert.strictEqual(create!.payload.sys_scope, APP_SYS_ID, 'the sys_id, never the name');
	assert.strictEqual(result.effectiveScope, 'x_acme_app');
	assert.strictEqual(result.sysScopeId, APP_SYS_ID);
});

test('create_artifact with explicit global omits sys_scope rather than writing the literal', async () => {
	harness.reply({ success: true, newRecord: { sys_id: 'abc', name: 'MyUtils', tableName: 'sys_script_include', scope: 'global' } });

	await command('create_artifact').handle(harness.context(), {
		table: 'sys_script_include',
		fields: { name: 'MyUtils' },
		scope: 'global',
	});

	const create = harness.sent.find((m) => m.action === 'createRecord');
	assert.ok(!('sys_scope' in create!.payload), "'global' is an absent field, not a value");
});

test('create_artifact refuses an unresolvable scope without sending a create', async () => {
	harness.reply(scopeLookupReply([])); // the lookup finds nothing

	await assert.rejects(
		() => command('create_artifact').handle(harness.context(), {
			table: 'sys_script_include',
			fields: { name: 'MyUtils' },
			scope: 'x_not_a_real_scope',
		}),
		(err: any) => err.code === 'E_INVALID_PARAMS'
	);

	assert.strictEqual(
		harness.sent.filter((m) => m.action === 'createRecord').length,
		0,
		'nothing may be created when the scope cannot be resolved'
	);
});

// ---------------------------------------------------------------------------
// create_record — the bug caught in review: sys_scope is a sys_metadata column,
// so a plain data row must never receive one. Scope here is the TRANSACTION
// scope and belongs in the query string.
// ---------------------------------------------------------------------------

test('create_record never injects sys_scope into a data row', async () => {
	harness.reply(scopeLookupReply([{ sys_id: APP_SYS_ID, scope: 'x_acme_app' }]));
	harness.reply({ success: true, status: 201, data: { result: { sys_id: 'inc1', number: 'INC001' } } });

	await command('create_record').handle(harness.context(), {
		table: 'incident',
		fields: { short_description: 'printer down' },
		scope: 'x_acme_app',
	});

	const rest = harness.sent.filter((m) => m.action === 'agentRestApi');
	const insert = rest[rest.length - 1];
	assert.strictEqual(insert.method, 'POST');
	assert.ok(!('sys_scope' in insert.body), 'a data row has no sys_scope column');
	assert.strictEqual(
		insert.queryParams.sysparm_transaction_scope,
		APP_SYS_ID,
		'a scoped write is controlled by the transaction scope'
	);
});

test('create_record without a scope sends neither sys_scope nor a transaction scope', async () => {
	harness.reply({ success: true, status: 201, data: { result: { sys_id: 'inc1', number: 'INC001' } } });

	await command('create_record').handle(harness.context(), {
		table: 'incident',
		fields: { short_description: 'printer down' },
	});

	const insert = harness.sent.find((m) => m.action === 'agentRestApi');
	assert.ok(!('sys_scope' in insert!.body));
	assert.strictEqual(insert!.queryParams.sysparm_transaction_scope, undefined);
});

test('create_record warns when an artifact table is used without a scope', async () => {
	harness.reply({ success: true, status: 201, data: { result: { sys_id: 'x1', name: 'Thing' } } });

	const result = await command('create_record').handle(harness.context(), {
		table: 'sys_script_include',
		fields: { name: 'Thing' },
	});

	assert.ok(
		Array.isArray(result.warnings) && /application artifact table/.test(result.warnings[0]),
		'reaching for the wrong tool should be flagged, not silently accepted'
	);
});

test('create_record leaves an explicitly pinned sys_scope alone', async () => {
	harness.reply({ success: true, status: 201, data: { result: { sys_id: 'x1' } } });

	await command('create_record').handle(harness.context(), {
		table: 'x_acme_app_thing',
		fields: { name: 'Thing', sys_scope: APP_SYS_ID },
	});

	const insert = harness.sent.find((m) => m.action === 'agentRestApi');
	assert.strictEqual(insert!.body.sys_scope, APP_SYS_ID, 'a caller-pinned value is theirs to keep');
	assert.strictEqual(insert!.queryParams.sysparm_transaction_scope, APP_SYS_ID);
});
