// "Pull instance changes into NOW SDK app": the SN Utils helper tab downloads
// the application package with the browser session (the same download
// `now-sdk transform` makes with its own login), and the SDK's own converter
// turns it into Fluent source in a temporary copy of the project. The user
// reviews the differences and picks what to copy into the project.
//
// Kept free of `vscode` imports so it can be unit tested under plain Node.
// packages/snu/src/nowsdk/ holds a byte-identical copy for the standalone
// bridge; src/test/nowSdkShared.test.ts fails when the two drift.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { NowSdkProjectError, assertSupportedProject, assertSupportedSdk, readNowSdkProject } from './NowSdkProject';
import { runNowSdk } from './NowSdkBuild';
import { choiceSetFields, choicesWouldBeOverwritten, isChoiceSet } from './NowSdkChoices';
import { disabledChoiceTables } from './NowSdkSource';

export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 20000;

/** Folders never copied into the staging project nor compared. */
const SKIP = new Set(['node_modules', 'dist', 'target', '.snu', '.git']);

export type PullChangeStatus = 'modified' | 'added' | 'removed';

export interface PullChange {
	/** Path relative to the project root, with forward slashes. */
	path: string;
	status: PullChangeStatus;
}

export interface PullStaging {
	/** Temporary folder holding everything for this pull; remove with cleanupPull. */
	tempDir: string;
	/** The project copy the SDK converted the instance package into. */
	stagingRoot: string;
	changes: PullChange[];
}

/**
 * Unpack a zip into `dest` with Node's zlib. Supports stored and deflated
 * entries, which is what the instance produces. Entry names that would land
 * outside `dest` are refused.
 */
export function extractZip(zip: Buffer, dest: string): string[] {
	const root = path.resolve(dest);
	// End of central directory: scan back from the end (it may carry a comment).
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
		if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) throw new NowSdkProjectError('The downloaded package is not a valid zip file.');
	const entries = zip.readUInt16LE(eocd + 10);
	let offset = zip.readUInt32LE(eocd + 16);
	if (entries > MAX_ENTRIES) throw new NowSdkProjectError('The downloaded package has too many files.');

	const written: string[] = [];
	let unpacked = 0;
	for (let n = 0; n < entries; n++) {
		if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) {
			throw new NowSdkProjectError('The downloaded package is damaged.');
		}
		const method = zip.readUInt16LE(offset + 10);
		const compressedSize = zip.readUInt32LE(offset + 20);
		const size = zip.readUInt32LE(offset + 24);
		const nameLength = zip.readUInt16LE(offset + 28);
		const extraLength = zip.readUInt16LE(offset + 30);
		const commentLength = zip.readUInt16LE(offset + 32);
		const localOffset = zip.readUInt32LE(offset + 42);
		const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
		offset += 46 + nameLength + extraLength + commentLength;

		const relative = name.replace(/\\/g, '/').replace(/^\/+/, '');
		if (!relative || relative.endsWith('/')) continue; // directory entry
		const target = path.resolve(root, relative);
		if (!target.startsWith(root + path.sep) || relative.split('/').includes('..')) {
			throw new NowSdkProjectError(`The downloaded package contains an unsafe path: ${name}`);
		}
		unpacked += size;
		if (unpacked > MAX_UNPACKED_BYTES) throw new NowSdkProjectError('The downloaded package is too large to unpack.');

		if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new NowSdkProjectError('The downloaded package is damaged.');
		const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
		const data = zip.subarray(dataStart, dataStart + compressedSize);
		let content: Buffer;
		if (method === 0) content = Buffer.from(data);
		else if (method === 8) content = zlib.inflateRawSync(data);
		else throw new NowSdkProjectError(`The downloaded package uses an unsupported compression (${method}).`);

		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
		written.push(relative);
	}
	return written;
}

function copyProject(from: string, to: string) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) copyProject(src, dst);
		else if (entry.isFile()) fs.copyFileSync(src, dst);
	}
}

/** Project files (forward-slash relative paths), leaving out build output, dependencies and .snu. */
export function listProjectFiles(root: string): string[] {
	return listFiles(root);
}

function listFiles(root: string, dir = root, out: string[] = []): string[] {
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) listFiles(root, full, out);
		else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
	}
	return out;
}

/** Files that differ between the project and the staged copy. */
export function diffProjects(projectRoot: string, stagingRoot: string): PullChange[] {
	const before = new Set(listFiles(projectRoot));
	const after = new Set(listFiles(stagingRoot));
	const changes: PullChange[] = [];
	for (const file of after) {
		if (!before.has(file)) {
			changes.push({ path: file, status: 'added' });
		} else if (!fs.readFileSync(path.join(projectRoot, file)).equals(fs.readFileSync(path.join(stagingRoot, file)))) {
			changes.push({ path: file, status: 'modified' });
		}
	}
	for (const file of before) {
		if (!after.has(file)) changes.push({ path: file, status: 'removed' });
	}
	return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Convert a downloaded application package into Fluent in a temporary copy of
 * the project and report what differs. The project itself is not touched.
 */
export async function stagePull(projectRoot: string, packageZip: Buffer, onOutput?: (text: string) => void): Promise<PullStaging> {
	if (packageZip.length > MAX_DOWNLOAD_BYTES) throw new NowSdkProjectError('The downloaded package is too large.');
	assertSupportedProject(readNowSdkProject(projectRoot));
	assertSupportedSdk(projectRoot);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-pull-'));
	try {
		const xmlDir = path.join(tempDir, 'package');
		extractZip(packageZip, xmlDir);
		const stagingRoot = path.join(tempDir, path.basename(projectRoot));
		copyProject(projectRoot, stagingRoot);
		fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(stagingRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
		await runNowSdk(stagingRoot, ['transform', '--from', xmlDir], onOutput);
		let changes = diffProjects(projectRoot, stagingRoot);
		// The SDK's converter can need a second pass to settle (it adds the
		// IDs of records it created on the first pass to keys.ts), so one pull
		// leaves the project stable instead of changing it again next time.
		if (changes.length > 0) {
			await runNowSdk(stagingRoot, ['transform', '--from', xmlDir], onOutput);
			changes = diffProjects(projectRoot, stagingRoot);
		}
		return { tempDir, stagingRoot, changes };
	} catch (e) {
		cleanupPull(tempDir);
		throw e;
	}
}

/** Copy the chosen changes from the staged copy into the project. */
export function applyPullChanges(projectRoot: string, stagingRoot: string, changes: PullChange[]): void {
	const root = path.resolve(projectRoot);
	for (const change of changes) {
		const target = path.resolve(root, change.path);
		if (!target.startsWith(root + path.sep)) continue;
		if (change.status === 'removed') {
			fs.rmSync(target, { force: true });
		} else {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(path.join(stagingRoot, change.path), target);
		}
	}
}

/** What a pull changed, to put the project back with undoPull. */
export interface PullUndo {
	/** Previous content per path; null means the pull added the file. */
	files: Array<{ path: string; previous: Buffer | null }>;
	/** What ScriptSync knew about the instance before the pull, put back by an undo. */
	sync?: SyncState;
}

/** The baseline for an instance and the pull marker, as saved before a pull. */
export interface SyncState {
	instance: string;
	/** Baseline files by name (the format file included); null when there was none. */
	baseline: Map<string, Buffer> | null;
	pullMarker: Buffer | null;
}

/** Save the baseline for an instance and the pull marker, to put back later. */
export function captureSyncState(projectRoot: string, instanceName: string): SyncState {
	const dir = baselineDir(projectRoot, instanceName);
	let baseline: Map<string, Buffer> | null = null;
	if (fs.existsSync(dir)) {
		baseline = new Map();
		for (const name of ['format', ...listDir(path.join(dir, 'update')).map((f) => path.join('update', f))]) {
			try { baseline.set(name, fs.readFileSync(path.join(dir, name))); } catch {}
		}
	}
	let marker: Buffer | null = null;
	try { marker = fs.readFileSync(pullMarker(projectRoot)); } catch {}
	return { instance: instanceName, baseline, pullMarker: marker };
}

/** Put back a state saved with captureSyncState. */
export function restoreSyncState(projectRoot: string, state: SyncState): void {
	const dir = baselineDir(projectRoot, state.instance);
	fs.rmSync(dir, { recursive: true, force: true });
	if (state.baseline) {
		fs.mkdirSync(path.join(dir, 'update'), { recursive: true });
		for (const [name, content] of state.baseline) fs.writeFileSync(path.join(dir, name), content);
	}
	if (state.pullMarker) fs.writeFileSync(pullMarker(projectRoot), state.pullMarker);
	else fs.rmSync(pullMarker(projectRoot), { force: true });
}

function listDir(dir: string): string[] {
	try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * Apply every added and modified file and remember what was there before.
 * Removals are never applied this way: a file missing from the instance
 * package is left for the user to delete.
 */
export function applyPullWithUndo(projectRoot: string, stagingRoot: string, changes: PullChange[], instanceName?: string): PullUndo {
	const root = path.resolve(projectRoot);
	const undo: PullUndo = { files: [], ...(instanceName ? { sync: captureSyncState(projectRoot, instanceName) } : {}) };
	const applied = changes.filter((c) => c.status !== 'removed');
	for (const change of applied) {
		const target = path.resolve(root, change.path);
		if (!target.startsWith(root + path.sep)) continue;
		undo.files.push({ path: change.path, previous: fs.existsSync(target) ? fs.readFileSync(target) : null });
	}
	applyPullChanges(projectRoot, stagingRoot, applied);
	return undo;
}

/** Put back what a pull changed: restore previous contents, remove added files. */
export function undoPull(projectRoot: string, undo: PullUndo): void {
	const root = path.resolve(projectRoot);
	for (const file of undo.files) {
		const target = path.resolve(root, file.path);
		if (!target.startsWith(root + path.sep)) continue;
		if (file.previous === null) {
			fs.rmSync(target, { force: true });
			// Remove folders the pull created and left empty.
			let dir = path.dirname(target);
			while (dir.startsWith(root + path.sep)) {
				try {
					if (fs.readdirSync(dir).length > 0) break;
					fs.rmdirSync(dir);
				} catch {
					break;
				}
				dir = path.dirname(dir);
			}
		} else {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, file.previous);
		}
	}
	// The instance changes the pull took in count as changes again.
	if (undo.sync) restoreSyncState(projectRoot, undo.sync);
}

/**
 * Of `paths` (relative to the project), the ones with uncommitted changes in
 * git. null when the project is not in a git repository or git is missing, in
 * which case a pull is reviewed file by file instead.
 */
export function gitUncommittedPaths(projectRoot: string, paths: string[]): Promise<string[] | null> {
	return new Promise((resolve) => {
		cp.execFile('git', ['-C', projectRoot, 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths], { timeout: 15000 }, (err, stdout) => {
			if (err) return resolve(null);
			const dirty = new Set<string>();
			const entries = String(stdout).split('\0').filter(Boolean);
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];
				const status = entry.slice(0, 2);
				dirty.add(entry.slice(3));
				if (status.includes('R') || status.includes('C')) i++; // skip the rename source
			}
			cp.execFile('git', ['-C', projectRoot, 'rev-parse', '--show-prefix'], { timeout: 15000 }, (err2, prefixOut) => {
				if (err2) return resolve(null);
				const prefix = String(prefixOut).trim();
				resolve(paths.filter((p) => dirty.has(prefix + p)));
			});
		});
	});
}

// ---- Instance baseline: what changed on the instance since the last sync ----
//
// After a deploy or pull, the records the instance returns for the app (the
// same package a pull downloads) are kept in .snu/baseline/<instance>. Before
// the next deploy the current records are compared with them, record by record.
// Comparing the raw records, not their Fluent conversion, also catches changes
// the SDK's converter ignores, such as the HTML of a UI page built from
// src/client. Only bookkeeping fields (updated on/by, modification count) are
// left out of the comparison.

export interface InstanceChange {
	/** Record label, e.g. "Script Include SpikeNew". */
	label: string;
	status: 'changed' | 'new' | 'removed';
	/**
	 * The record comes from the project's source in a way the SDK's pull
	 * cannot write back to (see `reason`): a pull cannot bring the change in,
	 * and the next deploy overwrites it.
	 */
	generated?: boolean;
	/** Why a pull cannot bring the change in, e.g. "compiled from your server source". */
	reason?: string;
	/** At a deploy: the fields changed on the instance that the build would overwrite. */
	fields?: string[];
	/** The record's file name in the package's update or author_elective_update folder. */
	file?: string;
}

export const TABLE_LABELS: Record<string, string> = {
	sys_script_include: 'Script Include',
	sys_script: 'Business Rule',
	sys_script_client: 'Client Script',
	sys_ui_action: 'UI Action',
	sys_ui_policy: 'UI Policy',
	sys_script_fix: 'Fix Script',
	sysauto_script: 'Scheduled Script',
	sys_hub_flow: 'Flow',
	sys_hub_action_type_definition: 'Flow Action',
	sys_db_object: 'Table',
	sys_dictionary: 'Column',
	sys_choice_set: 'Choices',
	sys_choice_v2: 'Choices',
	sys_security_acl: 'ACL',
	sys_user_role: 'Role',
	sys_properties: 'System Property',
	sys_ws_definition: 'Scripted REST API',
	sp_widget: 'Widget',
	sys_ui_page: 'UI Page',
	sys_ux_lib_asset: 'UI Asset',
	sys_module: 'Server Module',
	sys_app_application: 'Menu',
	sys_app_module: 'Module',
	sys_db_view: 'Database View',
	sys_ui_message: 'UI Message',
};

const BASELINE_FORMAT = 'records-v1';

function baselineDir(projectRoot: string, instanceName: string): string {
	return path.join(projectRoot, '.snu', 'baseline', instanceName.replace(/[^\w.-]/g, '_'));
}

/** A baseline in the current format exists; an older one counts as none until the next sync. */
export function hasBaseline(projectRoot: string, instanceName: string): boolean {
	try {
		return fs.readFileSync(path.join(baselineDir(projectRoot, instanceName), 'format'), 'utf8').trim() === BASELINE_FORMAT;
	} catch {
		return false;
	}
}

/** The app's records in a downloaded package, keyed by file name. */
export function readPackageRecords(packageZip: Buffer): Map<string, string> {
	return packageRecords(packageZip);
}

function packageRecords(packageZip: Buffer): Map<string, string> {
	if (packageZip.length > MAX_DOWNLOAD_BYTES) throw new NowSdkProjectError('The downloaded package is too large.');
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-records-'));
	try {
		extractZip(packageZip, tempDir);
		return readBuiltRecords(tempDir);
	} finally {
		cleanupPull(tempDir);
	}
}

/**
 * Record the instance's version of the app (a downloaded package) as the
 * baseline. Files in `keep` stay at their previous baseline version (or stay
 * absent), so changes a pull could not bring in keep being reported.
 */
export async function saveBaselineFromPackage(projectRoot: string, instanceName: string, packageZip: Buffer, _onOutput?: (text: string) => void, keep: string[] = []): Promise<void> {
	const records = packageRecords(packageZip);
	const dir = baselineDir(projectRoot, instanceName);
	const previous = readBaselineRecords(projectRoot, instanceName);
	for (const file of keep) {
		if (previous.has(file)) records.set(file, previous.get(file)!);
		else records.delete(file);
	}
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, 'update'), { recursive: true });
	for (const [file, xml] of records) fs.writeFileSync(path.join(dir, 'update', file), xml);
	fs.writeFileSync(path.join(dir, 'format'), BASELINE_FORMAT + '\n');
	const ignore = path.join(projectRoot, '.snu', '.gitignore');
	if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
}

function readBaselineRecords(projectRoot: string, instanceName: string): Map<string, string> {
	const records = new Map<string, string>();
	const dir = path.join(baselineDir(projectRoot, instanceName), 'update');
	try {
		for (const file of fs.readdirSync(dir)) records.set(file, fs.readFileSync(path.join(dir, file), 'utf8'));
	} catch {}
	return records;
}

function readBuiltRecords(appOutputDir: string): Map<string, string> {
	const records = new Map<string, string>();
	// Both folders use the same update-name identity. Platform downloads may
	// put choices in update while SDK builds put them in author_elective_update.
	for (const folder of ['update', 'author_elective_update']) {
		const dir = path.join(appOutputDir, folder);
		for (const file of listDir(dir)) {
			if (!file.endsWith('.xml')) continue;
			const xml = fs.readFileSync(path.join(dir, file), 'utf8');
			if (records.has(file) && records.get(file) !== xml) throw new NowSdkProjectError(`The app package contains conflicting copies of ${file}.`);
			records.set(file, xml);
		}
	}
	return records;
}

function unescapeXml(value: string): string {
	return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmlField(xml: string, name: string): string {
	const m = new RegExp(`<${name}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`).exec(xml);
	return (m ? (m[1] ?? unescapeXml(m[2] ?? '')) : '').trim();
}

/** Fields that describe the record's history, not its content. */
// federated_id is filled in by the platform after an install, never by a person.
const HISTORY_FIELDS = new Set(['sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_created_on', 'sys_created_by', 'sys_update_name', 'sys_package', 'sys_scope', 'sys_policy', 'federated_id']);

/** The top-level fields of a record's XML, values normalized for comparison (or as stored, with `raw`). */
function recordFields(xml: string, raw = false): Map<string, string> {
	if (isChoiceSet(xml)) return choiceSetFields(xml, raw);
	const fields = new Map<string, string>();
	const body = /<record_update[^>]*>\s*<([a-z0-9_]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/.exec(xml)?.[2] || '';
	const re = /<([A-Za-z0-9_]+)(?:\s[^>]*?)?(?:\/>|>(<!\[CDATA\[[\s\S]*?\]\]>|[^<]*)<\/\1>)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) {
		if (HISTORY_FIELDS.has(m[1])) continue;
		let value = m[2] ?? '';
		const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(value);
		value = cdata ? cdata[1] : unescapeXml(value);
		fields.set(m[1], raw ? value : comparableValue(value));
	}
	return fields;
}

/**
 * A field value as compared: line endings, trailing spaces and blank lines at
 * the ends normalized (a form save introduces those), everything else kept,
 * so a change in indentation or inside a string still counts.
 */
function comparableValue(value: string): string {
	return value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function sameRecord(a: string, b: string): boolean {
	const fa = recordFields(a), fb = recordFields(b);
	// A record this parser cannot read is compared as text.
	if (fa.size === 0 && fb.size === 0) return comparableValue(a) === comparableValue(b);
	if (fa.size !== fb.size) return false;
	for (const [k, v] of fa) if (fb.get(k) !== v) return false;
	return true;
}

function recordLabel(table: string, xml: string, sysId: string): string {
	if (isChoiceSet(xml)) {
		const fields = choiceSetFields(xml);
		return `Choices ${fields.get('name')}.${fields.get('element')}`;
	}
	const fields = table === 'sys_ui_page' ? ['description', 'name', 'endpoint'] : table === 'sys_dictionary' ? ['element'] : ['name', 'title', 'label', 'sys_name', 'path', 'key'];
	let name = fields.map((f) => xmlField(xml, f)).find(Boolean) || sysId;
	if (table === 'sys_dictionary' && xmlField(xml, 'name')) name = `${xmlField(xml, 'name')}.${name}`;
	if (table === 'sys_module') name = path.basename(name);
	return `${TABLE_LABELS[table] || table} ${name}`;
}

/** Tables the SDK regenerates from the project on every build and never converts back. */
const NOT_CONVERTED = new Set([
	'sys_ux_lib_asset', 'sys_ux_theme_asset', 'db_image', 'sys_ui_message', 'sys_attachment', 'sys_attachment_doc',
	'sn_glider_source_artifact', 'sn_glider_source_artifact_m2m',
]);

/**
 * Record sys_ids whose Fluent definition carries `@fluent-disable-sync` (on the
 * statement, or `@fluent-disable-sync-for-file`), which the SDK's pull skips.
 */
function disableSyncIds(projectRoot: string): Set<string> {
	const ids = new Set<string>();
	const all = listFiles(projectRoot);
	const files = all.filter((f) => f.endsWith('.now.ts'));
	const marked = files.filter((f) => {
		try {
			return fs.readFileSync(path.join(projectRoot, f), 'utf8').includes('@fluent-disable-sync');
		} catch {
			return false;
		}
	});
	if (marked.length === 0) return ids;
	const keys = new Map<string, string>();
	const keysFile = all.find((f) => f.endsWith('generated/keys.ts'));
	if (keysFile) {
		const text = fs.readFileSync(path.join(projectRoot, keysFile), 'utf8');
		const re = /['"]?([\w.$-]+)['"]?\s*:\s*\{\s*table:\s*'[^']+'\s*id:\s*'([0-9a-f]{32})'/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) keys.set(m[1], m[2]);
	}
	for (const file of marked) {
		const text = fs.readFileSync(path.join(projectRoot, file), 'utf8');
		for (const table of disabledChoiceTables(projectRoot, file, text)) ids.add(`choices:${table}`);
		const wholeFile = text.includes('@fluent-disable-sync-for-file');
		const re = /Now\.ID\[\s*['"]([^'"]+)['"]\s*\]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const id = keys.get(m[1]) || (/^[0-9a-f]{32}$/.test(m[1]) ? m[1] : undefined);
			if (!id) continue;
			if (wholeFile) {
				ids.add(id);
				continue;
			}
			// The statement that holds this $id: its start is the last line before
			// it that begins a top-level call; the marker sits in the lines above.
			const before = text.slice(0, m.index);
			const starts = [...before.matchAll(/^(?:export\s+)?(?:const\s+\w+\s*=\s*)?[A-Za-z_$][\w$.]*\(/gm)];
			const start = starts.length ? starts[starts.length - 1].index! : 0;
			const above = before.slice(0, start).split('\n').slice(-4).join('\n');
			if (above.includes('@fluent-disable-sync')) ids.add(id);
		}
	}
	return ids;
}

function generatedReason(table: string, xml: string, sysId: string, disableSync: Set<string>): string | undefined {
	if (isChoiceSet(xml)) {
		const fields = choiceSetFields(xml);
		if (disableSync.has('choices:*') || disableSync.has(`choices:${fields.get('name')}`) || disableSync.has(`choices:${fields.get('name')}.${fields.get('element')}`)) return 'marked @fluent-disable-sync in your source';
	}
	if (xml.includes('@fluent-import-html')) return 'built from your UI source';
	if (table === 'sys_module') return 'compiled from your server source';
	if (NOT_CONVERTED.has(table) || table.startsWith('sys_aix_')) return 'regenerated from your source on every build';
	if (xml.includes('// @fluent-module ')) return 'its script calls a module function in your source';
	if (disableSync.has(sysId)) return 'marked @fluent-disable-sync in your source';
	return undefined;
}

function describeRecord(file: string, xml: string, status: InstanceChange['status'], disableSync: Set<string>): InstanceChange {
	const m = /^([a-z0-9_]+?)_([0-9a-f]{32})\.xml$/.exec(file);
	const table = m?.[1] || /<record_update[^>]*>\s*<([a-z0-9_]+)\s/.exec(xml)?.[1] || 'record';
	const sysId = m?.[2] || '';
	const change: InstanceChange = { label: recordLabel(table, xml, sysId || file), status, file };
	const reason = generatedReason(table, xml, sysId, disableSync);
	if (reason) {
		change.generated = true;
		change.reason = reason;
	}
	return change;
}

/** One record of the baseline (the state after the last sync), if any. */
export function readBaselineRecord(projectRoot: string, instanceName: string, file: string): string | undefined {
	return readBaselineRecords(projectRoot, instanceName).get(path.basename(file));
}

/** A record's fields (history fields left out), values as stored. */
export function readRecordFields(xml: string): Map<string, string> {
	return recordFields(xml, true);
}

/** Of `fields`, the ones whose value in `builtXml` differs from `instanceXml` (compared as a deploy check does). */
export function fieldsBuiltDifferently(builtXml: string | undefined, instanceXml: string, fields: string[]): string[] {
	if (!builtXml) return fields;
	const fb = recordFields(builtXml), fi = recordFields(instanceXml);
	return fields.filter((f) => (fb.get(f) ?? '') !== (fi.get(f) ?? ''));
}

/** The fields that differ between two versions of a record (compared as a deploy check does). */
export function changedFieldNames(beforeXml: string, afterXml: string): string[] {
	const fb = recordFields(beforeXml), fa = recordFields(afterXml);
	return [...new Set([...fb.keys(), ...fa.keys()])].filter((f) => (fb.get(f) ?? '') !== (fa.get(f) ?? ''));
}

/** One record of the last build (dist/app/update), if any. */
export function readBuiltRecord(appOutputDir: string, file: string): string | undefined {
	return readBuiltRecords(appOutputDir).get(path.basename(file));
}

/** keys.ts: record sys_id -> the Now.ID name it is defined with. */
export function readKeyNames(projectRoot: string): Map<string, string> {
	const names = new Map<string, string>();
	const keysFile = listFiles(projectRoot).find((f) => f.endsWith('generated/keys.ts'));
	if (!keysFile) return names;
	const text = fs.readFileSync(path.join(projectRoot, keysFile), 'utf8');
	const re = /['"]?([\w.$-]+)['"]?\s*:\s*\{\s*table:\s*'[^']+'\s*id:\s*'([0-9a-f]{32})'/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) names.set(m[2], m[1]);
	return names;
}

/** A record as readable text, one field per section, for a diff view. */
export function recordForReading(xml: string | undefined): string {
	if (!xml) return '';
	const lines: string[] = [];
	for (const [field, value] of [...recordFields(xml, true)].sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`── ${field} ──`, value.trim(), '');
	}
	return lines.join('\n');
}

/**
 * Accept that the next deploy overwrites a change made on the instance: the
 * baseline takes the instance version of that record, so it is no longer
 * reported. `instanceXml` undefined means the record was deleted there.
 */
export function dismissInstanceChange(projectRoot: string, instanceName: string, file: string, instanceXml: string | undefined): void {
	if (!hasBaseline(projectRoot, instanceName)) return;
	const target = path.join(baselineDir(projectRoot, instanceName), 'update', path.basename(file));
	if (instanceXml === undefined) fs.rmSync(target, { force: true });
	else fs.writeFileSync(target, instanceXml);
}

/** Records that changed on the instance since the baseline, from records already read. */
export function instanceChangesFromRecords(projectRoot: string, instanceName: string, now: Map<string, string>): InstanceChange[] {
	if (!hasBaseline(projectRoot, instanceName)) return [];
	const before = readBaselineRecords(projectRoot, instanceName);
	const disableSync = disableSyncIds(projectRoot);
	const changes: InstanceChange[] = [];
	for (const [file, xml] of now) {
		const old = before.get(file);
		if (old === undefined) changes.push(describeRecord(file, xml, 'new', disableSync));
		else if (!sameRecord(old, xml)) changes.push(describeRecord(file, xml, 'changed', disableSync));
	}
	for (const [file, xml] of before) {
		if (!now.has(file)) changes.push(describeRecord(file, xml, 'removed', disableSync));
	}
	return changes.sort((a, b) => a.label.localeCompare(b.label));
}

/** Records that changed on the instance since the baseline, from a downloaded package. */
export async function instanceChangesFromPackage(projectRoot: string, instanceName: string, packageZip: Buffer, _onOutput?: (text: string) => void): Promise<InstanceChange[]> {
	if (!hasBaseline(projectRoot, instanceName)) return [];
	return instanceChangesFromRecords(projectRoot, instanceName, packageRecords(packageZip));
}

/**
 * At a deploy, with the app just built: which instance changes since the
 * baseline the install would overwrite. A record counts only when a field
 * changed on the instance differs from the build, so changes already in the
 * source (for example pulled) do not. Records that exist only on the instance
 * are left alone by an install and are reported separately.
 */
export function deployConflicts(projectRoot: string, instanceName: string, packageZip: Buffer, appOutputDir: string): { overwritten: InstanceChange[]; instanceOnly: InstanceChange[] } {
	const overwritten: InstanceChange[] = [];
	const instanceOnly: InstanceChange[] = [];
	if (!hasBaseline(projectRoot, instanceName)) return { overwritten, instanceOnly };
	const now = packageRecords(packageZip);
	const before = readBaselineRecords(projectRoot, instanceName);
	const built = readBuiltRecords(appOutputDir);
	const disableSync = disableSyncIds(projectRoot);
	const same = (a: Map<string, string>, b: Map<string, string>, key: string) => (a.get(key) ?? '') === (b.get(key) ?? '');
	const lostFields = (was: string | undefined, current: string, build: string, fields: string[]) => {
		const fi = recordFields(current), fb = recordFields(build);
		return fields.filter((field) => field === 'choices' && isChoiceSet(current) && isChoiceSet(build)
			? choicesWouldBeOverwritten(was, current, build)
			: !same(fi, fb, field));
	};
	for (const file of new Set([...now.keys(), ...before.keys()])) {
		const was = before.get(file);
		const is = now.get(file);
		const build = built.get(file);
		if (is !== undefined && was === undefined) {
			if (build === undefined) {
				instanceOnly.push(describeRecord(file, is, 'new', disableSync));
				continue;
			}
			const fi = recordFields(is), fb = recordFields(build);
			const differing = lostFields(undefined, is, build, [...new Set([...fi.keys(), ...fb.keys()])]);
			if (differing.length) overwritten.push({ ...describeRecord(file, is, 'new', disableSync), fields: differing });
			continue;
		}
		if (is === undefined && was !== undefined) {
			if (build !== undefined) overwritten.push({ ...describeRecord(file, was, 'removed', disableSync), fields: [] });
			continue;
		}
		if (is === undefined || was === undefined || build === undefined) continue;
		const fw = recordFields(was), fi = recordFields(is);
		const changed = [...new Set([...fw.keys(), ...fi.keys()])].filter((k) => !same(fw, fi, k));
		const lost = lostFields(was, is, build, changed);
		if (lost.length) overwritten.push({ ...describeRecord(file, is, 'changed', disableSync), fields: lost });
	}
	const byLabel = (a: InstanceChange, b: InstanceChange) => a.label.localeCompare(b.label);
	return { overwritten: overwritten.sort(byLabel), instanceOnly: instanceOnly.sort(byLabel) };
}

function pullMarker(projectRoot: string): string {
	return path.join(projectRoot, '.snu', 'pull.json');
}

/** Whether this project was pulled before (the first pull also writes out SDK defaults). */
export function hasPulledBefore(projectRoot: string): boolean {
	return fs.existsSync(pullMarker(projectRoot));
}

export interface SyncMarker {
	instance: string;
	/** ISO timestamp. */
	at: string;
}

function readMarker(file: string, key: string): SyncMarker | null {
	try {
		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		return typeof data?.instance === 'string' && typeof data?.[key] === 'string' ? { instance: data.instance, at: data[key] } : null;
	} catch {
		return null;
	}
}

/** When the app was last deployed and pulled from this project. */
export function readSyncMarkers(projectRoot: string): { deploy: SyncMarker | null; pull: SyncMarker | null } {
	return {
		deploy: readMarker(path.join(projectRoot, '.snu', 'deployed.json'), 'deployedAt'),
		pull: readMarker(pullMarker(projectRoot), 'pulledAt'),
	};
}

/** Remember the last successful deploy. */
export function markDeployed(projectRoot: string, instanceName: string): void {
	try {
		const dir = path.join(projectRoot, '.snu');
		fs.mkdirSync(dir, { recursive: true });
		if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
		fs.writeFileSync(path.join(dir, 'deployed.json'), JSON.stringify({ instance: instanceName, deployedAt: new Date().toISOString() }, null, 2) + '\n');
	} catch {}
}

/** Remember the last pull. */
export function markPulled(projectRoot: string, instanceName: string): void {
	try {
		const dir = path.dirname(pullMarker(projectRoot));
		fs.mkdirSync(dir, { recursive: true });
		if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
		fs.writeFileSync(pullMarker(projectRoot), JSON.stringify({ instance: instanceName, pulledAt: new Date().toISOString() }, null, 2) + '\n');
	} catch {}
}

export function cleanupPull(tempDir: string): void {
	try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}
