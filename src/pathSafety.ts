import * as fs from 'fs';
import * as path from 'path';

// Path-safety hardening for values supplied by the connected ServiceNow instance
// (instance name, scope, table, screenshot file name). These are treated as
// untrusted input: path construction is hardened so they are validated as safe
// single path segments and can never resolve outside the sync root.
//
// This module is intentionally vscode-free so the logic can be unit-tested with
// plain Node (see scripts/test-path-safety.mjs). workspaceRoot.ts wraps
// assertPathWithinRoot with the workspace-root default used at the call sites.

/** Reject anything that is not a single, safe path segment. Throws otherwise. */
export function sanitizePathComponent(component: string): string {
	if (typeof component !== 'string') {
		throw new Error('sn-scriptsync: path component is not a string');
	}
	const value = component.trim();
	if (!value || value === '.' || value === '..') {
		throw new Error(`sn-scriptsync: unsafe path component ${JSON.stringify(component)}`);
	}
	// No separators, NUL, home-dir, or Windows drive/UNC markers.
	if (/[\\/\0]/.test(value) || /^[A-Za-z]:/.test(value) || value.startsWith('~')) {
		throw new Error(`sn-scriptsync: unsafe path component ${JSON.stringify(component)}`);
	}
	return value;
}

/**
 * Throw unless `targetPath` resolves to a location inside `root`. Returns the
 * resolved absolute path. This is the hard guarantee applied at every write
 * choke-point: whatever assembled the path, the result must stay under root.
 */
export function assertPathWithinRoot(targetPath: string, root: string): string {
	if (!root) {
		throw new Error('sn-scriptsync: no workspace root — refusing to write');
	}
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(targetPath);
	const rel = path.relative(resolvedRoot, resolved);
	if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
		throw new Error(`sn-scriptsync: path escapes the sync root — refusing to write ${JSON.stringify(targetPath)}`);
	}

	// Lexical containment alone still follows symlinks below the root. Reject
	// each existing symlink component, including an existing target. Callers
	// that create parent directories repeat this immediately before writing.
	let current = resolvedRoot;
	for (const component of rel.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			if (fs.lstatSync(current).isSymbolicLink()) {
				throw new Error(`sn-scriptsync: path contains a symbolic link — refusing to write ${JSON.stringify(targetPath)}`);
			}
		} catch (error: any) {
			if (error?.code === 'ENOENT') break;
			throw error;
		}
	}
	return resolved;
}

/** Join untrusted components under `root` and prove the result cannot escape it. */
export function safeJoinUnderRoot(root: string, ...components: string[]): string {
	if (!root) {
		throw new Error('sn-scriptsync: no workspace root');
	}
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(resolvedRoot, ...components.map(sanitizePathComponent));
	return assertPathWithinRoot(resolved, resolvedRoot);
}
