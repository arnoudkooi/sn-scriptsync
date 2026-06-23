import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Single source of truth for "which workspace folder does ScriptSync sync into".
//
// Historically the extension used the deprecated `vscode.workspace.rootPath`,
// which in a multi-root workspace always resolves to the FIRST folder. That
// meant ScriptSync would dump its instance folders into whatever happened to be
// at the top of the workspace (e.g. an unrelated source repo) instead of the
// folder the user actually wants to sync into.
//
// Resolution order for a multi-root workspace:
//   0. A remembered user choice (the folder picker stores its fsPath in
//      workspace state and pushes it here) — always wins when it still matches
//      an open folder.
//   1. A folder that is already a ScriptSync sync folder (contains a synced
//      instance folder — a child dir with `_settings.json`). NOTE: we do NOT
//      key off `autocomplete/server.d.ts`; a regular repo can legitimately
//      track that file and would be misdetected as a sync folder.
//   2. A folder whose name ends with the configured `sn-scriptsync.path`
//      value (the documented auto-activation convention, default "scriptsync").
//   3. The first empty folder (a fresh, dedicated sync folder).
//   4. Fallback: the first folder (legacy `rootPath` behaviour).
//
// When more than one folder qualifies (rules 1–3 produce multiple candidates)
// the choice is ambiguous: extension.ts prompts the user once with a picker and
// remembers the answer, instead of silently guessing.
//
// Single-folder and no-folder workspaces keep the exact previous behaviour.

let cachedRoot: string | undefined;
let resolved = false;

// The remembered pick (fsPath). Hydrated from workspace state by extension.ts.
let rememberedRoot: string | undefined;

export interface SyncFolderCandidate {
	path: string;
	name: string;
	/** Why this folder is a candidate, surfaced in the picker. */
	reason: 'initialized' | 'name' | 'empty';
}

function getConfiguredSyncDirName(): string {
	let syncDir = vscode.workspace.getConfiguration('sn-scriptsync').get<string>('path') || 'scriptsync';
	syncDir = syncDir.replace('~', '');
	if (path.sep === '\\') {
		syncDir = syncDir.replace(/\//g, '\\');
	}
	return syncDir;
}

// A real ScriptSync sync folder has at least one synced instance: an immediate
// child directory containing `_settings.json` (or the legacy `settings.json`).
// This is the definitive signature — far more reliable than the autocomplete
// scaffolding, which any project may happen to contain.
function isScriptSyncFolder(folder: string): boolean {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(folder, { withFileTypes: true });
	} catch {
		return false;
	}
	return entries.some((d) => {
		if (!d.isDirectory() || d.name.startsWith('.')) return false;
		const child = path.join(folder, d.name);
		return fs.existsSync(path.join(child, '_settings.json'))
			|| fs.existsSync(path.join(child, 'settings.json'));
	});
}

function isEmptyFolder(folder: string): boolean {
	try {
		// Ignore dotfiles (.git, .vscode, .DS_Store, ...) — a folder that only
		// holds editor/VCS metadata is still "empty" for our purposes.
		return fs.readdirSync(folder).filter((name) => !name.startsWith('.')).length === 0;
	} catch {
		return false;
	}
}

/** Open folders, deduped to fsPaths. */
function workspaceFolderPaths(): string[] {
	return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

/**
 * Folders that look like a plausible sync target, in priority order
 * (initialized > name match > empty). A folder is listed at most once.
 */
export function getSyncFolderCandidates(): SyncFolderCandidate[] {
	const paths = workspaceFolderPaths();
	const syncDirName = getConfiguredSyncDirName();
	const seen = new Set<string>();
	const out: SyncFolderCandidate[] = [];

	const add = (p: string, reason: SyncFolderCandidate['reason']) => {
		if (seen.has(p)) return;
		seen.add(p);
		out.push({ path: p, name: path.basename(p), reason });
	};

	paths.filter(isScriptSyncFolder).forEach((p) => add(p, 'initialized'));
	if (syncDirName) {
		paths.filter((p) => path.basename(p).endsWith(syncDirName)).forEach((p) => add(p, 'name'));
	}
	paths.filter(isEmptyFolder).forEach((p) => add(p, 'empty'));

	return out;
}

function resolveWorkspaceRoot(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;

	if (!folders || folders.length === 0) {
		return vscode.workspace.rootPath || undefined;
	}
	if (folders.length === 1) {
		return folders[0].uri.fsPath;
	}

	const paths = folders.map((f) => f.uri.fsPath);

	// 0. Remembered user choice wins outright (if it still exists).
	if (rememberedRoot && paths.includes(rememberedRoot)) {
		return rememberedRoot;
	}

	const candidates = getSyncFolderCandidates();
	if (candidates.length) return candidates[0].path;

	// 4. Legacy fallback: first folder (== old rootPath).
	return paths[0];
}

/**
 * The workspace folder ScriptSync should read from / write into. Cached after
 * first resolution; call `resetWorkspaceRoot()` (wired to
 * onDidChangeWorkspaceFolders / config changes) when inputs change.
 */
export function getWorkspaceRoot(): string | undefined {
	if (!resolved) {
		cachedRoot = resolveWorkspaceRoot();
		resolved = true;
	}
	return cachedRoot;
}

/** Invalidate the cached root (folders added/removed, config changed). */
export function resetWorkspaceRoot(): void {
	resolved = false;
	cachedRoot = undefined;
}

/** Push the remembered pick (fsPath) from workspace state. Resets the cache. */
export function setRememberedWorkspaceRoot(fsPath: string | undefined): void {
	rememberedRoot = fsPath || undefined;
	resetWorkspaceRoot();
}

/** True when there is more than one open folder. */
export function isMultiRootWorkspace(): boolean {
	return (vscode.workspace.workspaceFolders?.length || 0) > 1;
}

/**
 * Whether the sync folder is ambiguous and should be confirmed by the user:
 * a multi-root workspace, no usable remembered pick, and not exactly one
 * obvious candidate.
 */
export function needsFolderChoice(): boolean {
	if (!isMultiRootWorkspace()) return false;
	const paths = workspaceFolderPaths();
	if (rememberedRoot && paths.includes(rememberedRoot)) return false;
	return getSyncFolderCandidates().length !== 1;
}
