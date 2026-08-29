/**
 * Application scope resolution for record and artifact creation.
 *
 * Creating an artifact in the wrong scope is a silent, expensive mistake: it
 * surfaces at Store-commit or export time, far from the command that caused it,
 * and the remedy is delete-and-recreate. A spurious error when the caller
 * genuinely wanted Global costs one flag, immediately, at the call site.
 *
 * The rule is narrow on purpose. Omitting a scope is FINE: the field is left off
 * the payload and the instance applies the session's current application, the
 * same as creating the record in the UI. What is never allowed is inventing one
 * — writing the literal string 'global' into sys_scope (which overrode the
 * active application and caused the incident), or shipping an unresolvable
 * scope name where a sys_id belongs (which silently filed an artifact into the
 * wrong application instead of failing).
 *
 * The active application is deliberately not READ here either. Callers are told
 * where the record actually landed instead, so an agent that cannot see the app
 * picker can still verify placement rather than assume it.
 *
 * Pure logic with an injected lookup: no transport, no `vscode`, no fs. The
 * extension mirrors this file (the CLI and the extension are separate
 * builds with no shared runtime dependency, as with portReclaim.ts); both
 * suites run the same conformance vectors in scopeVectors.
 */

export const GLOBAL_SCOPE = 'global';

/** A `sys_scope` row, reduced to what resolution needs. */
export interface ScopeRow {
	sys_id: string;
	scope: string;
}

/** Looks a scope up by its `scope` name. Undefined when there is no such row. */
export type ScopeLookup = (scopeName: string) => Promise<ScopeRow | undefined>;

export interface ScopeResolution {
	/** True when the caller stated a scope. False means the session decides. */
	specified: boolean;
	/** Exactly what the caller asked for; undefined when they asked for nothing. */
	requestedScope?: string;
	/**
	 * What the write will use: 'global', the resolved scope name, or undefined
	 * when unspecified — in which case the instance applies the session's
	 * current application and only the created record can say where it landed.
	 */
	effectiveScope?: string;
	/**
	 * sys_id to write as `sys_scope` / send as `sysparm_transaction_scope`.
	 * Undefined for global AND for unspecified: in both cases the field must be
	 * omitted rather than set to the string 'global' — writing that literal is
	 * what forced artifacts into Global regardless of the active application.
	 */
	sysScopeId?: string;
}

export interface ScopeResolutionError extends Error {
	code: 'E_INVALID_PARAMS';
}

function fail(code: ScopeResolutionError['code'], message: string): never {
	throw Object.assign(new Error(message), { code });
}

export function isSysId(value: string): boolean {
	return /^[0-9a-f]{32}$/i.test(value);
}

/**
 * Decide the scope for a create.
 *
 * Precedence:
 *   1. An explicit `fields.sys_scope` sys_id — the caller has already resolved it.
 *   2. The `scope` parameter, by name or sys_id.
 *   3. Nothing — the session's current application, by omission. Never an
 *      invented Global.
 */
export async function resolveCreateScope(options: {
	scope?: unknown;
	fields?: Record<string, any> | null;
	lookup: ScopeLookup;
}): Promise<ScopeResolution> {
	const { fields, lookup } = options;

	// 1. The caller pinned sys_scope directly.
	const pinned = typeof fields?.sys_scope === 'string' ? fields.sys_scope.trim() : '';
	if (pinned) {
		if (pinned.toLowerCase() === GLOBAL_SCOPE) {
			return { specified: true, requestedScope: GLOBAL_SCOPE, effectiveScope: GLOBAL_SCOPE };
		}
		if (isSysId(pinned)) {
			return { specified: true, requestedScope: pinned, effectiveScope: pinned, sysScopeId: pinned };
		}
		fail(
			'E_INVALID_PARAMS',
			`fields.sys_scope must be a sys_id or 'global', got '${pinned}'. ` +
				`Pass the application name as scope instead, and it will be resolved for you.`
		);
	}

	const requested = typeof options.scope === 'string' ? options.scope.trim() : '';

	// 2. Nothing stated: leave sys_scope off and let the instance apply the
	//    session's current application, exactly as a UI create would. Inventing
	//    'global' here is the bug this file exists to prevent.
	if (!requested) return { specified: false };

	// 3. Global, but on purpose.
	if (requested.toLowerCase() === GLOBAL_SCOPE) {
		return { specified: true, requestedScope: requested, effectiveScope: GLOBAL_SCOPE };
	}

	// 4. Already a sys_id.
	if (isSysId(requested)) {
		return { specified: true, requestedScope: requested, effectiveScope: requested, sysScopeId: requested };
	}

	// 5. A name: resolve it against the instance. Deliberately not served from
	//    the local scopes.json cache — that cache is written opportunistically
	//    and is empty in a fresh workspace, which is exactly how a scope NAME
	//    used to reach the instance in the sys_scope field. It also cannot tell
	//    that an instance was cloned or rebuilt with new sys_ids.
	const row = await lookup(requested);
	const sysId = typeof row?.sys_id === 'string' ? row.sys_id.trim() : '';
	if (!sysId) {
		fail(
			'E_INVALID_PARAMS',
			`Unknown application scope '${requested}' on this instance. ` +
				`Pass the scope's exact name (e.g. x_acme_app), its sys_id, or --scope global.`
		);
	}

	return {
		specified: true,
		requestedScope: requested,
		effectiveScope: row?.scope || requested,
		sysScopeId: sysId,
	};
}

/**
 * Apply a resolution to an outgoing METADATA record body.
 *
 * Only for records that carry a `sys_scope` column — sys_metadata descendants,
 * i.e. application files. A plain data row (incident, task, sys_user) has no
 * such column, and a scoped write there is controlled by the transaction scope
 * instead: use `sysScopeId` as `sysparm_transaction_scope` and leave the body
 * alone.
 *
 * Global omits `sys_scope` entirely: writing the literal string 'global' into
 * the field is what stamped artifacts into Global no matter what application
 * was active.
 */
export function applyScopeToFields(
	fields: Record<string, any>,
	resolution: ScopeResolution
): Record<string, any> {
	if (!resolution.sysScopeId) {
		// Drop any inherited sys_scope: global means the field is absent, not
		// set to the string 'global'.
		const { sys_scope, ...rest } = fields;
		return rest;
	}
	return { ...fields, sys_scope: resolution.sysScopeId };
}
