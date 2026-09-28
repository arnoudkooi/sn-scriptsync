// ServiceNow SDK (NOW SDK / Fluent) project support.
//
// A folder containing `now.config.json` is a NOW SDK project. Its sources
// (`*.now.ts`, `src/server/**`) compile into an application package; they are
// never ScriptSync field files, so the field sync must skip them entirely and
// the app is deployed as a whole package instead (see NowSdkDeploy.ts).
//
// Kept free of `vscode` imports so it can be unit tested under plain Node.
// packages/snu/src/nowsdk/ holds a byte-identical copy for the standalone
// bridge; src/test/nowSdkShared.test.ts fails when the two drift.

import * as fs from 'fs';
import * as path from 'path';

export const NOW_CONFIG_FILE = 'now.config.json';
const LINK_DIR = '.snu';
const LINK_FILE = 'deploy.json';

export interface NowSdkProject {
	root: string;
	name: string;
	scope: string;
	scopeId: string;
	version: string;
	appOutputDir: string;
	packOutputDir: string;
	/** now.config.json `type`: 'package' (default) or 'configuration'. */
	type: string;
	/** now.config.json `installAs`, e.g. 'store'. */
	installAs: string;
	hasHostedPlugins: boolean;
}

/** ServiceNow SDK versions whose packages and install protocol match what ScriptSync sends. */
export const SUPPORTED_SDK = { min: '4.1.0', belowMajor: 5 };

export interface NowSdkDeployLink {
	instance: string;
	url: string;
}

export class NowSdkProjectError extends Error {}

// Directory -> "contains now.config.json", briefly cached because the field
// sync asks for every saved and watched file.
const CACHE_TTL_MS = 5000;
const configCache = new Map<string, { has: boolean; at: number }>();

function dirHasNowConfig(dir: string): boolean {
	const cached = configCache.get(dir);
	const now = Date.now();
	if (cached && now - cached.at < CACHE_TTL_MS) return cached.has;
	let has = false;
	try {
		has = fs.statSync(path.join(dir, NOW_CONFIG_FILE)).isFile();
	} catch {
		has = false;
	}
	configCache.set(dir, { has, at: now });
	return has;
}

/**
 * The NOW SDK project root that contains `filePath`, or null. When `stopAt` is
 * given, only directories from the file's folder up to and including `stopAt`
 * are checked, so a project outside that folder never matches.
 */
export function findNowSdkProjectRoot(filePath: string, stopAt?: string): string | null {
	if (!filePath) return null;
	const limit = stopAt ? path.resolve(stopAt) : undefined;
	let dir = path.dirname(path.resolve(filePath));
	if (limit && dir !== limit && !dir.startsWith(limit + path.sep)) return null;
	while (true) {
		if (dirHasNowConfig(dir)) return dir;
		if (limit && dir === limit) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readJson(file: string): any {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e: any) {
		throw new NowSdkProjectError(`Could not read ${path.basename(file)}: ${e?.message || e}`);
	}
}

/** Resolve a configured output folder, refusing anything outside the project. */
function projectDir(root: string, configured: unknown, fallback: string): string {
	const rel = typeof configured === 'string' && configured.trim() ? configured.trim() : fallback;
	const resolved = path.resolve(root, rel);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		throw new NowSdkProjectError(`Output folder "${rel}" is outside the project.`);
	}
	return resolved;
}

export function readNowSdkProject(root: string): NowSdkProject {
	const resolvedRoot = path.resolve(root);
	const config = readJson(path.join(resolvedRoot, NOW_CONFIG_FILE));
	const pkg = readJson(path.join(resolvedRoot, 'package.json'));

	const scope = String(config?.scope || '');
	const scopeId = String(config?.scopeId || '');
	const version = String(pkg?.version || '');
	if (!/^[a-z][a-z0-9_]{1,17}$/.test(scope)) throw new NowSdkProjectError(`Invalid scope "${scope}" in ${NOW_CONFIG_FILE}.`);
	if (!/^([0-9a-f]{32}|global)$/.test(scopeId)) throw new NowSdkProjectError(`Invalid scopeId "${scopeId}" in ${NOW_CONFIG_FILE}.`);
	if (!/^[0-9A-Za-z.+-]{1,32}$/.test(version)) throw new NowSdkProjectError(`Invalid or missing version in package.json.`);

	return {
		root: resolvedRoot,
		name: String(config?.name || scope),
		scope,
		scopeId,
		version,
		appOutputDir: projectDir(resolvedRoot, config?.appOutputDir, path.join('dist', 'app')),
		packOutputDir: projectDir(resolvedRoot, config?.packOutputDir, 'target'),
		type: String(config?.type || 'package'),
		installAs: String(config?.installAs || ''),
		hasHostedPlugins: !!config?.hostedPlugins && Object.keys(config.hostedPlugins).length > 0,
	};
}

/**
 * Refuse app types ScriptSync does not deploy or pull the way the SDK does,
 * with a pointer to `now-sdk install` / `now-sdk transform` for them.
 */
export function assertSupportedProject(project: NowSdkProject): void {
	const fallback = 'Use the ServiceNow SDK itself (now-sdk install / now-sdk transform) for this app.';
	if (project.type === 'configuration') {
		throw new NowSdkProjectError(`${project.name} is a configuration project, which the SDK installs into an update set. That is not supported yet. ${fallback}`);
	}
	if (project.installAs === 'store' || project.hasHostedPlugins) {
		throw new NowSdkProjectError(`${project.name} installs as a Store app (installAs "store" or hostedPlugins). That is not supported yet. ${fallback}`);
	}
	if (project.scope === 'global' || project.scopeId === 'global') {
		throw new NowSdkProjectError(`${project.name} is a global-scope app. That is not supported yet. ${fallback}`);
	}
}

function versionParts(version: string): number[] | null {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The ServiceNow SDK version installed in the project, or null when it is not installed. */
export function readSdkVersion(root: string): string | null {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@servicenow', 'sdk', 'package.json'), 'utf8'));
		return typeof pkg?.version === 'string' ? pkg.version : null;
	} catch {
		return null;
	}
}

/** Refuse SDK versions outside the range whose packages ScriptSync handles. */
export function assertSupportedSdk(root: string): string {
	const version = readSdkVersion(root);
	if (!version) {
		throw new NowSdkProjectError(`The ServiceNow SDK is not installed in ${path.basename(root)}. Run npm install in the project first.`);
	}
	const have = versionParts(version);
	const min = versionParts(SUPPORTED_SDK.min)!;
	const tooOld = !have || have[0] < min[0] || (have[0] === min[0] && (have[1] < min[1] || (have[1] === min[1] && have[2] < min[2])));
	if (tooOld || (have && have[0] >= SUPPORTED_SDK.belowMajor)) {
		throw new NowSdkProjectError(`${path.basename(root)} uses ServiceNow SDK ${version}; ScriptSync supports ${SUPPORTED_SDK.min} up to ${SUPPORTED_SDK.belowMajor - 1}.x. Use now-sdk install and now-sdk transform, or update the SDK in the project.`);
	}
	return version;
}

/**
 * Flow and action record ids in the built app, for activating them after an
 * install (the SDK's own post-install step). Read from the build output file
 * names, which follow `<table>_<sys_id>.xml`.
 */
export function listFlowRecordIds(appOutputDir: string): { flows: string[]; actions: string[] } {
	const flows: string[] = [];
	const actions: string[] = [];
	let files: string[] = [];
	try {
		files = fs.readdirSync(path.join(appOutputDir, 'update'));
	} catch {
		return { flows, actions };
	}
	for (const f of files) {
		let m = /^sys_hub_flow_([0-9a-f]{32})\.xml$/.exec(f);
		if (m) { flows.push(m[1]); continue; }
		m = /^sys_hub_action_type_definition_([0-9a-f]{32})\.xml$/.exec(f);
		if (m) actions.push(m[1]);
	}
	return { flows, actions };
}

/** The zip path reported by `now-sdk pack`, or null. */
export function parsePackOutput(output: string): string | null {
	const m = /artifact emitted as "([^"]+\.zip)"/i.exec(output || '');
	return m ? m[1] : null;
}

/** Newest `.zip` in a folder, used when the pack output could not be parsed. */
export function findNewestZip(dir: string): string | null {
	let newest: { file: string; mtime: number } | null = null;
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	for (const f of entries) {
		if (!f.toLowerCase().endsWith('.zip')) continue;
		const full = path.join(dir, f);
		try {
			const mtime = fs.statSync(full).mtimeMs;
			if (!newest || mtime > newest.mtime) newest = { file: full, mtime };
		} catch {}
	}
	return newest ? newest.file : null;
}

/**
 * The instance this project deploys to. Stored in `.snu/deploy.json` inside the
 * project, next to a `.gitignore` that keeps the folder out of git: the link is
 * a personal choice, not project configuration.
 */
export function readDeployLink(root: string): NowSdkDeployLink | null {
	try {
		const link = JSON.parse(fs.readFileSync(path.join(root, LINK_DIR, LINK_FILE), 'utf8'));
		if (link && typeof link.instance === 'string' && link.instance && typeof link.url === 'string' && /^https?:\/\//.test(link.url)) {
			return { instance: link.instance, url: link.url };
		}
	} catch {}
	return null;
}

export function writeDeployLink(root: string, link: NowSdkDeployLink): void {
	const dir = path.join(root, LINK_DIR);
	fs.mkdirSync(dir, { recursive: true });
	const ignore = path.join(dir, '.gitignore');
	if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
	fs.writeFileSync(path.join(dir, LINK_FILE), JSON.stringify({ instance: link.instance, url: link.url }, null, 2) + '\n');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', '.snu', '.vscode']);

/** NOW SDK project roots under `root`, a few levels deep, skipping build and dependency folders. */
export function findNowSdkProjects(root: string, maxDepth = 3): string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (dirHasNowConfig(dir)) {
			found.push(dir);
			return; // a project does not contain further projects
		}
		if (depth >= maxDepth) return;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
				walk(path.join(dir, e.name), depth + 1);
			}
		}
	};
	walk(path.resolve(root), 0);
	return found.sort();
}

/**
 * Whether `p` is `root` or below it. path.relative compares case-insensitively
 * on Windows, so `C:\proj` is inside a workspace VS Code reports as `c:\`
 * (issue #162 follow-up); on macOS and Linux the compare stays exact.
 */
export function isPathInside(p: string, root: string, pathImpl: typeof path = path): boolean {
	const rel = pathImpl.relative(root, p);
	return rel === '' || (rel !== '..' && !rel.startsWith('..' + pathImpl.sep) && !pathImpl.isAbsolute(rel));
}

/**
 * The project an agent asked for. `projectPath` (relative to `root`, or
 * absolute) must stay inside `root`, symlinks included. Without it, `root`
 * must contain exactly one project.
 */
export function resolveNowSdkProjectRoot(root: string, projectPath?: string): string {
	const base = path.resolve(root);
	let realBase = base;
	try { realBase = fs.realpathSync(base); } catch {}
	if (projectPath) {
		const target = path.resolve(base, projectPath);
		if (!isPathInside(target, base)) throw new NowSdkProjectError(`projectPath must be inside ${base}.`);
		let realTarget = target;
		try { realTarget = fs.realpathSync(target); } catch {
			throw new NowSdkProjectError(`projectPath not found: ${projectPath}`);
		}
		if (!isPathInside(realTarget, realBase)) throw new NowSdkProjectError(`projectPath must be inside ${base}.`);
		const dir = fs.statSync(realTarget).isDirectory() ? realTarget : path.dirname(realTarget);
		if (!dirHasNowConfig(dir)) throw new NowSdkProjectError(`No ${NOW_CONFIG_FILE} in ${projectPath}.`);
		return dir;
	}
	const projects = findNowSdkProjects(base);
	if (projects.length === 1) return projects[0];
	if (projects.length === 0) throw new NowSdkProjectError(`No NOW SDK project (${NOW_CONFIG_FILE}) found under ${base}.`);
	throw new NowSdkProjectError(`Several NOW SDK projects found; pass projectPath: ${projects.map((p) => path.relative(base, p) || '.').join(', ')}`);
}
