/**
 * Conformance vectors for scope resolution.
 *
 * The extension and the `snu` CLI are separate builds with no shared runtime
 * dependency, so scopeResolver.ts is deliberately mirrored rather than shared.
 * Mirroring is how the two hosts drifted in the first place — the CLI resolved
 * scopes properly while the extension hardcoded Global — so both test suites
 * run this same table. A behaviour change in one host that is not made in the
 * other fails there.
 *
 * Keep this file free of imports: it is copied verbatim into packages/snu.
 */

export interface ScopeVector {
	name: string;
	scope?: unknown;
	fields?: Record<string, any> | null;
	/** Scope names the fake instance knows about, as name -> sys_id. */
	known?: Record<string, string>;
	expect:
		| { ok: true; specified?: boolean; effectiveScope?: string; sysScopeId?: string }
		| { ok: false; code: 'E_INVALID_PARAMS' };
}

const APP_SYS_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

export const SCOPE_VECTORS: ScopeVector[] = [
	{
		// The incident: an omitted scope used to be turned into a literal
		// sys_scope:'global', overriding the active application. Omitting the
		// field lets the instance apply the session's application instead.
		name: 'omitted scope is left unspecified, never invented as global',
		expect: { ok: true, specified: false, effectiveScope: undefined, sysScopeId: undefined },
	},
	{
		name: 'empty scope is unspecified',
		scope: '   ',
		expect: { ok: true, specified: false, effectiveScope: undefined, sysScopeId: undefined },
	},
	{
		name: 'non-string scope is unspecified',
		scope: 42,
		expect: { ok: true, specified: false, effectiveScope: undefined, sysScopeId: undefined },
	},
	{
		name: 'explicit global resolves to global with no sys_scope',
		scope: 'global',
		expect: { ok: true, specified: true, effectiveScope: 'global', sysScopeId: undefined },
	},
	{
		name: 'explicit global is case-insensitive',
		scope: 'Global',
		expect: { ok: true, specified: true, effectiveScope: 'global', sysScopeId: undefined },
	},
	{
		name: 'a known scope name resolves to its sys_id',
		scope: 'x_acme_app',
		known: { x_acme_app: APP_SYS_ID },
		expect: { ok: true, specified: true, effectiveScope: 'x_acme_app', sysScopeId: APP_SYS_ID },
	},
	{
		name: 'an unknown scope name is refused, never passed through as a name',
		scope: 'x_acme_app',
		known: {},
		expect: { ok: false, code: 'E_INVALID_PARAMS' },
	},
	{
		name: 'a sys_id scope is used directly',
		scope: APP_SYS_ID,
		expect: { ok: true, specified: true, effectiveScope: APP_SYS_ID, sysScopeId: APP_SYS_ID },
	},
	{
		name: 'a pinned sys_scope sys_id in fields wins',
		fields: { sys_scope: APP_SYS_ID },
		expect: { ok: true, specified: true, effectiveScope: APP_SYS_ID, sysScopeId: APP_SYS_ID },
	},
	{
		name: 'a pinned sys_scope of global means global',
		fields: { sys_scope: 'global' },
		expect: { ok: true, specified: true, effectiveScope: 'global', sysScopeId: undefined },
	},
	{
		name: 'a pinned sys_scope that is neither sys_id nor global is refused',
		fields: { sys_scope: 'x_acme_app' },
		expect: { ok: false, code: 'E_INVALID_PARAMS' },
	},
	{
		name: 'a pinned sys_scope beats a conflicting scope param',
		scope: 'global',
		fields: { sys_scope: APP_SYS_ID },
		expect: { ok: true, specified: true, effectiveScope: APP_SYS_ID, sysScopeId: APP_SYS_ID },
	},
	{
		name: 'surrounding whitespace on a scope name is tolerated',
		scope: '  x_acme_app  ',
		known: { x_acme_app: APP_SYS_ID },
		expect: { ok: true, specified: true, effectiveScope: 'x_acme_app', sysScopeId: APP_SYS_ID },
	},
];
