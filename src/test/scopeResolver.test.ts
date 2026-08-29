import test from 'node:test';
import assert from 'node:assert';
import { resolveCreateScope, applyScopeToFields, isSysId } from '../agent/scopeResolver';
import { SCOPE_VECTORS } from '../agent/scopeVectors';

function lookupFrom(known: Record<string, string> | undefined) {
	return async (scopeName: string) => {
		const sys_id = known?.[scopeName];
		return sys_id ? { sys_id, scope: scopeName } : undefined;
	};
}

// The shared conformance table. packages/snu runs the identical vectors against
// its mirrored copy: a rule changed in one host and not the other fails there.
for (const vector of SCOPE_VECTORS) {
	test(`scope vector: ${vector.name}`, async () => {
		const run = () =>
			resolveCreateScope({
				scope: vector.scope,
				fields: vector.fields,
				lookup: lookupFrom(vector.known),
			});

		if (vector.expect.ok) {
			const resolution = await run();
			assert.strictEqual(resolution.effectiveScope, vector.expect.effectiveScope);
			assert.strictEqual(resolution.sysScopeId, vector.expect.sysScopeId);
			if (vector.expect.specified !== undefined) {
				assert.strictEqual(resolution.specified, vector.expect.specified);
			}
		} else {
			await assert.rejects(run, (err: any) => err.code === (vector.expect as any).code);
		}
	});
}

test('an omitted scope resolves to unspecified and never invents global', async () => {
	// The incident: this used to become a literal sys_scope:'global'.
	const resolution = await resolveCreateScope({ lookup: async () => undefined });
	assert.strictEqual(resolution.specified, false);
	assert.strictEqual(resolution.sysScopeId, undefined);
	assert.strictEqual(resolution.effectiveScope, undefined);
});

test('an unspecified resolution strips sys_scope from the body', () => {
	const out = applyScopeToFields({ name: 'MyUtils' }, { specified: false });
	assert.ok(!('sys_scope' in out), 'the instance must decide, so the field is absent');
});

test('global omits sys_scope rather than writing the literal string', () => {
	// Writing sys_scope:'global' is what stamped artifacts into Global.
	const out = applyScopeToFields(
		{ name: 'MyUtils', sys_scope: 'leftover' },
		{ specified: true, requestedScope: 'global', effectiveScope: 'global' }
	);
	assert.ok(!('sys_scope' in out), 'sys_scope must be absent for global');
	assert.strictEqual(out.name, 'MyUtils');
});

test('a resolved scope sets sys_scope to the sys_id', () => {
	const sysId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
	const out = applyScopeToFields(
		{ name: 'MyUtils' },
		{ specified: true, requestedScope: 'x_acme_app', effectiveScope: 'x_acme_app', sysScopeId: sysId }
	);
	assert.strictEqual(out.sys_scope, sysId);
});

test('a scope name is never mistaken for a sys_id', () => {
	assert.strictEqual(isSysId('x_acme_app'), false);
	assert.strictEqual(isSysId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), true);
	assert.strictEqual(isSysId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'), false, '31 chars');
});

test('the lookup is consulted exactly once for a named scope', async () => {
	let calls = 0;
	await resolveCreateScope({
		scope: 'x_acme_app',
		lookup: async (name) => {
			calls++;
			return { sys_id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', scope: name };
		},
	});
	assert.strictEqual(calls, 1);
});

test('global never hits the instance', async () => {
	let calls = 0;
	await resolveCreateScope({
		scope: 'global',
		lookup: async () => { calls++; return undefined; },
	});
	assert.strictEqual(calls, 0);
});
