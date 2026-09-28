import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { applyPullChanges, applyPullWithUndo, markPulled, readSyncMarkers, cleanupPull, deployConflicts, diffProjects, dismissInstanceChange, extractZip, gitUncommittedPaths, hasBaseline, instanceChangesFromPackage, instanceChangesFromRecords, readBaselineRecord, readPackageRecords, recordForReading, saveBaselineFromPackage, stagePull, undoPull } from '../NowSdkPull';
import { NowSdkProjectError } from '../NowSdkProject';
import { makeZip } from './helpers/zip';

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('extracts stored and deflated entries, skipping folders', () => {
	const dest = tmp('snu-zip-');
	const written = extractZip(makeZip([
		{ name: '/scope/', content: '' },
		{ name: '/scope/sys_app_x.xml', content: '<app/>' },
		{ name: 'update/sys_script_include_y.xml', content: '<record>'.repeat(200), deflate: true },
	]), dest);
	assert.deepStrictEqual(written, ['scope/sys_app_x.xml', 'update/sys_script_include_y.xml']);
	assert.strictEqual(fs.readFileSync(path.join(dest, 'update', 'sys_script_include_y.xml'), 'utf8'), '<record>'.repeat(200));
});

test('refuses entries that would land outside the folder, and damaged zips', () => {
	const dest = tmp('snu-zip-');
	assert.throws(() => extractZip(makeZip([{ name: '../escape.xml', content: 'x' }]), dest), NowSdkProjectError);
	assert.throws(() => extractZip(makeZip([{ name: 'a/../../escape.xml', content: 'x' }]), dest), NowSdkProjectError);
	assert.ok(!fs.existsSync(path.join(path.dirname(dest), 'escape.xml')));
	assert.throws(() => extractZip(Buffer.from('not a zip at all, just some text padding it out'), dest), /not a valid zip/);
});

test('diffs projects and applies only the chosen changes', () => {
	const project = tmp('snu-proj-');
	const staged = tmp('snu-staged-');
	for (const [root, files] of [[project, { 'a.ts': '1', 'same.ts': 's', 'gone.ts': 'g' }], [staged, { 'a.ts': '2', 'same.ts': 's', 'dir/new.ts': 'n' }]] as const) {
		for (const [file, content] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), content);
		}
	}
	fs.mkdirSync(path.join(project, 'node_modules', 'x'), { recursive: true });
	fs.writeFileSync(path.join(project, 'node_modules', 'x', 'i.js'), 'ignored');
	const changes = diffProjects(project, staged);
	assert.deepStrictEqual(changes, [
		{ path: 'a.ts', status: 'modified' },
		{ path: 'dir/new.ts', status: 'added' },
		{ path: 'gone.ts', status: 'removed' },
	]);
	applyPullChanges(project, staged, changes.filter((c) => c.status !== 'removed'));
	assert.strictEqual(fs.readFileSync(path.join(project, 'a.ts'), 'utf8'), '2');
	assert.strictEqual(fs.readFileSync(path.join(project, 'dir', 'new.ts'), 'utf8'), 'n');
	assert.ok(fs.existsSync(path.join(project, 'gone.ts')), 'an unchosen removal keeps the file');
	applyPullChanges(project, staged, [{ path: '../outside.ts', status: 'added' }]);
	assert.ok(!fs.existsSync(path.join(path.dirname(project), 'outside.ts')));
});

test('stagePull converts in a copy and never touches the project', async () => {
	const project = tmp('snu-pullproj-');
	fs.writeFileSync(path.join(project, 'now.config.json'), JSON.stringify({ scope: 'x_1_app', scopeId: 'f'.repeat(32) }));
	fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ version: '1.0.0' }));
	fs.mkdirSync(path.join(project, 'node_modules', '@servicenow', 'sdk'), { recursive: true });
	fs.writeFileSync(path.join(project, 'node_modules', '@servicenow', 'sdk', 'package.json'), JSON.stringify({ version: '4.13.0' }));
	fs.mkdirSync(path.join(project, 'src'), { recursive: true });
	fs.writeFileSync(path.join(project, 'src', 'include.js'), "return 'v1'");
	const bin = path.join(project, 'node_modules', '.bin');
	fs.mkdirSync(bin, { recursive: true });
	// Fake now-sdk: "transform --from <dir>" copies the downloaded script into src/.
	fs.writeFileSync(path.join(bin, 'now-sdk'), [
		'#!/bin/sh',
		'[ "$1" = "transform" ] && [ "$2" = "--from" ] || exit 2',
		'cp "$3/update/include.js" src/include.js',
		'cp "$3/update/include.js" src/added.js',
	].join('\n'), { mode: 0o755 });

	const staged = await stagePull(project, makeZip([{ name: 'update/include.js', content: "return 'v2-instance'", deflate: true }]));
	try {
		assert.deepStrictEqual(staged.changes, [
			{ path: 'src/added.js', status: 'added' },
			{ path: 'src/include.js', status: 'modified' },
		]);
		assert.strictEqual(fs.readFileSync(path.join(project, 'src', 'include.js'), 'utf8'), "return 'v1'");
		assert.ok(!fs.existsSync(path.join(project, 'src', 'added.js')));
		assert.strictEqual(fs.readFileSync(path.join(staged.stagingRoot, 'src', 'include.js'), 'utf8'), "return 'v2-instance'");
	} finally {
		cleanupPull(staged.tempDir);
	}
	assert.ok(!fs.existsSync(staged.tempDir));
});

// Issue #161: under VS Code's Electron runtime on Windows a recursive rmSync
// follows the staging junction and empties the project's node_modules. Plain
// Node does not reproduce that, so assert the precondition instead: every link
// is gone before the recursive delete runs, and the target is untouched.
test('cleanupPull removes the node_modules link before deleting, leaving the project intact', () => {
	const project = tmp('snu-pullproj-');
	fs.mkdirSync(path.join(project, 'node_modules', '.bin'), { recursive: true });
	fs.writeFileSync(path.join(project, 'node_modules', '.bin', 'now-sdk'), 'x');
	const tempDir = tmp('snu-pull-');
	const stagingRoot = path.join(tempDir, 'proj');
	fs.mkdirSync(path.join(stagingRoot, 'src'), { recursive: true });
	fs.symlinkSync(path.join(project, 'node_modules'), path.join(stagingRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

	const linksLeft = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isSymbolicLink() ? [path.join(dir, e.name)] : e.isDirectory() ? linksLeft(path.join(dir, e.name)) : []);
	// The module object, not the read-only namespace import, so the patch is
	// what NowSdkPull sees.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fsModule = require('fs');
	const realRmSync = fsModule.rmSync;
	let seen: string[] | null = null;
	fsModule.rmSync = (target: fs.PathLike, opts?: fs.RmOptions) => {
		if (String(target) === tempDir) seen = linksLeft(tempDir);
		return realRmSync(target, opts);
	};
	try {
		cleanupPull(tempDir);
	} finally {
		fsModule.rmSync = realRmSync;
	}

	assert.deepStrictEqual(seen, [], 'no link was left for the recursive delete to follow');
	assert.ok(!fs.existsSync(tempDir));
	assert.ok(fs.existsSync(path.join(project, 'node_modules', '.bin', 'now-sdk')), 'project node_modules intact');
});

test('stagePull refuses a project without the SDK installed', async () => {
	const project = tmp('snu-pullproj-');
	fs.writeFileSync(path.join(project, 'now.config.json'), JSON.stringify({ scope: 'x_1_app', scopeId: 'f'.repeat(32) }));
	fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ version: '1.0.0' }));
	await assert.rejects(stagePull(project, makeZip([{ name: 'a.xml', content: 'x' }])), /npm install/);
});

test('apply with undo puts the project back, including added files and their folders', () => {
	const project = tmp('snu-undo-');
	const staged = tmp('snu-undo-staged-');
	fs.writeFileSync(path.join(project, 'a.ts'), 'mine');
	fs.writeFileSync(path.join(project, 'keep.ts'), 'keep');
	fs.writeFileSync(path.join(staged, 'a.ts'), 'instance');
	fs.mkdirSync(path.join(staged, 'gen', 'deep'), { recursive: true });
	fs.writeFileSync(path.join(staged, 'gen', 'deep', 'new.ts'), 'new');
	const undo = applyPullWithUndo(project, staged, [
		{ path: 'a.ts', status: 'modified' },
		{ path: 'gen/deep/new.ts', status: 'added' },
		{ path: 'keep.ts', status: 'removed' },
	]);
	assert.strictEqual(fs.readFileSync(path.join(project, 'a.ts'), 'utf8'), 'instance');
	assert.ok(fs.existsSync(path.join(project, 'gen', 'deep', 'new.ts')));
	assert.ok(fs.existsSync(path.join(project, 'keep.ts')), 'removals are never applied by a one-click pull');
	undoPull(project, undo);
	assert.strictEqual(fs.readFileSync(path.join(project, 'a.ts'), 'utf8'), 'mine');
	assert.ok(!fs.existsSync(path.join(project, 'gen')), 'folders the pull created are gone again');
	assert.ok(fs.existsSync(path.join(project, 'keep.ts')));
});

test('git check: clean files pass, uncommitted ones are named, no repository gives null', async () => {
	const repo = tmp('snu-git-');
	const git = (...args: string[]) => cp.execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
	git('init', '-q');
	const project = path.join(repo, 'apps', 'spike');
	fs.mkdirSync(path.join(project, 'src'), { recursive: true });
	fs.writeFileSync(path.join(project, 'src', 'a.ts'), '1');
	fs.writeFileSync(path.join(project, 'src', 'b.ts'), '1');
	git('add', '-A');
	git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
	assert.deepStrictEqual(await gitUncommittedPaths(project, ['src/a.ts', 'src/b.ts', 'src/new.ts']), []);
	fs.writeFileSync(path.join(project, 'src', 'b.ts'), 'edited');
	assert.deepStrictEqual(await gitUncommittedPaths(project, ['src/a.ts', 'src/b.ts']), ['src/b.ts']);
	assert.strictEqual(await gitUncommittedPaths(tmp('snu-nogit-'), ['a.ts']), null);
});

test('instance changes since the baseline compare the raw records, ignoring bookkeeping fields', async () => {
	const project = tmp('snu-base-');
	const rec = (table: string, id: string, fields: string, bookkeeping = '<sys_updated_on>2026-09-01 10:00:00</sys_updated_on><sys_mod_count>0</sys_mod_count>') =>
		({ name: `update/${table}_${id}.xml`, content: `<?xml version="1.0"?><record_update table="${table}"><${table} action="INSERT_OR_UPDATE"><sys_id>${id}</sys_id>${fields}${bookkeeping}</${table}></record_update>` });
	const si = 'a'.repeat(32), fix = 'b'.repeat(32), page = 'c'.repeat(32), br = 'd'.repeat(32), added = 'e'.repeat(32);
	const baseline = makeZip([
		rec('sys_script_include', si, '<name>SpikeInclude</name><script><![CDATA[v1]]></script>'),
		rec('sys_script_fix', fix, '<name>Inline</name><script>x</script>'),
		rec('sys_ui_page', page, '<description>Todo Board</description><html><![CDATA[<!-- @fluent-import-html --><title>Todo Board</title>]]></html>'),
		rec('sys_script', br, '<name>Sync</name><script>y</script>'),
		{ name: 'update/', content: '' },
	]);
	assert.strictEqual(hasBaseline(project, 'dev1'), false);
	await saveBaselineFromPackage(project, 'dev1', baseline);
	assert.strictEqual(hasBaseline(project, 'dev1'), true);
	assert.deepStrictEqual(await instanceChangesFromPackage(project, 'dev1', baseline), []);

	const now = makeZip([
		rec('sys_script_include', si, '<name>SpikeInclude</name><script><![CDATA[v2]]></script>', '<sys_updated_on>2026-09-27 10:00:00</sys_updated_on><sys_mod_count>1</sys_mod_count>'),
		rec('sys_ui_page', page, '<description>Todo Board</description><html><![CDATA[<!-- @fluent-import-html --><title>Todo Board by Arnoud</title>]]></html>'),
		// Touched (saved without changes): only bookkeeping differs, so not a change.
		rec('sys_script', br, '<name>Sync</name><script>y</script>', '<sys_updated_on>2026-09-27 11:00:00</sys_updated_on><sys_mod_count>3</sys_mod_count>'),
		rec('sys_script_include', added, '<name>SpikeNew</name>', ''),
	]);
	const strip = (list: any[]) => list.map(({ file, ...rest }) => rest);
	assert.deepStrictEqual(strip(await instanceChangesFromPackage(project, 'dev1', now)), [
		{ label: 'Fix Script Inline', status: 'removed' },
		{ label: 'Script Include SpikeInclude', status: 'changed' },
		{ label: 'Script Include SpikeNew', status: 'new' },
		{ label: 'UI Page Todo Board', status: 'changed', generated: true, reason: 'built from your UI source' },
	]);
	assert.ok(fs.existsSync(path.join(project, '.snu', '.gitignore')), 'the baseline folder stays out of git');
});

test('a baseline in the older format counts as none', () => {
	const project = tmp('snu-oldbase-');
	fs.mkdirSync(path.join(project, '.snu', 'baseline', 'dev1', 'src'), { recursive: true });
	assert.strictEqual(hasBaseline(project, 'dev1'), false);
});

// ---- Deploy conflicts and why a pull cannot bring a change in ---------------

const xmlRecord = (table: string, id: string, fields: string, bookkeeping = '') =>
	`<?xml version="1.0"?><record_update table="${table}"><${table} action="INSERT_OR_UPDATE"><sys_id>${id}</sys_id>${fields}${bookkeeping}</${table}></record_update>`;
const pkg = (records: Array<[string, string, string]>) =>
	makeZip(records.map(([table, id, fields]) => ({ name: `update/${table}_${id}.xml`, content: xmlRecord(table, id, fields) })));
function writeBuild(root: string, records: Array<[string, string, string]>) {
	const dir = path.join(root, 'dist', 'app', 'update');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	for (const [table, id, fields] of records) fs.writeFileSync(path.join(dir, `${table}_${id}.xml`), xmlRecord(table, id, fields));
}

test('a deploy only counts instance changes the build would overwrite, per field', async () => {
	const root = tmp('snu-conflict-');
	const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32), D = 'd'.repeat(32), E = 'e'.repeat(32);
	await saveBaselineFromPackage(root, 'dev1', pkg([
		['sys_script_include', A, '<name>Pulled</name><script>v1</script>'],
		['sys_script_include', B, '<name>Lost</name><script>v1</script><active>true</active>'],
		['sys_script', C, '<name>Unsupported</name><script>x</script><abort_action>false</abort_action>'],
		['sys_script_fix', D, '<name>Deleted there</name><script>z</script>'],
	]));
	const instance = pkg([
		['sys_script_include', A, '<name>Pulled</name><script>v2</script>'],
		['sys_script_include', B, '<name>Lost</name><script>v2</script><active>false</active>'],
		['sys_script', C, '<name>Unsupported</name><script>x</script><abort_action>true</abort_action>'],
		['sys_script_include', E, '<name>Only there</name><script>n</script>'],
	]);
	writeBuild(root, [
		['sys_script_include', A, '<name>Pulled</name><script>v2</script>'],
		['sys_script_include', B, '<name>Lost</name><script>v1</script><active>false</active>'],
		['sys_script', C, '<name>Unsupported</name><script>x</script>'],
		['sys_script_fix', D, '<name>Deleted there</name><script>z</script>'],
	]);
	const { overwritten, instanceOnly } = deployConflicts(root, 'dev1', instance, path.join(root, 'dist', 'app'));
	const brief = (list: any[]) => list.map((c) => [c.label, c.status, c.fields]);
	assert.deepStrictEqual(brief(overwritten), [
		['Business Rule Unsupported', 'changed', ['abort_action']],
		['Fix Script Deleted there', 'removed', []],
		['Script Include Lost', 'changed', ['script']],
	], 'a change already in the source (Pulled) is not a conflict; an unsupported field is');
	assert.deepStrictEqual(brief(instanceOnly), [['Script Include Only there', 'new', undefined]]);
	assert.deepStrictEqual(deployConflicts(tmp('snu-nobase-'), 'dev1', instance, path.join(root, 'dist', 'app')), { overwritten: [], instanceOnly: [] });
});

test('explains why a pull cannot bring a change in', async () => {
	const root = tmp('snu-reason-');
	const ids = ['1', '2', '3', '4', '5'].map((c) => c.repeat(32));
	fs.mkdirSync(path.join(root, 'src', 'fluent', 'generated'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src', 'fluent', 'generated', 'keys.ts'),
		`explicit: {\n  frozen_rule: {\n    table: 'sys_script'\n    id: '${ids[4]}'\n  }\n}`);
	fs.writeFileSync(path.join(root, 'src', 'fluent', 'rules.now.ts'),
		`import { BusinessRule } from '@servicenow/sdk/core'\n\n// @fluent-disable-sync\nBusinessRule({\n    $id: Now.ID['frozen_rule'],\n    name: 'Frozen',\n})\n`);
	const before: Array<[string, string, string]> = [
		['sys_module', ids[0], '<path>x/app/0.0.1/src/server/rules.ts</path><content>a</content>'],
		['sys_script', ids[1], '<name>Glue</name><script>// @fluent-module syncTaskState;false;src/server/rules.ts\nrequire(x)</script>'],
		['sys_ux_lib_asset', ids[2], '<name>main.jsdbx</name><source>a</source>'],
		['sys_ui_message', ids[3], '<key>Hello</key><message>Hi</message>'],
		['sys_script', ids[4], '<name>Frozen</name><script>a</script>'],
	];
	await saveBaselineFromPackage(root, 'dev1', pkg(before));
	const after = before.map(([t, id, f]) => [t, id, f.replace('>a<', '>b<').replace('>Hi<', '>Hey<').replace('require(x)', 'require(x); extra()')] as [string, string, string]);
	const reasons = (await instanceChangesFromPackage(root, 'dev1', pkg(after))).map((c) => [c.label, c.reason]);
	assert.deepStrictEqual(reasons, [
		['Business Rule Frozen', 'marked @fluent-disable-sync in your source'],
		['Business Rule Glue', 'its script calls a module function in your source'],
		['Server Module rules.ts', 'compiled from your server source'],
		['UI Asset main.jsdbx', 'regenerated from your source on every build'],
		['UI Message Hello', 'regenerated from your source on every build'],
	]);
});

test('a baseline refresh can keep records a pull could not bring in', async () => {
	const root = tmp('snu-keep-');
	const A = 'a'.repeat(32), B = 'b'.repeat(32);
	await saveBaselineFromPackage(root, 'dev1', pkg([['sys_module', A, '<content>v1</content>'], ['sys_script_include', B, '<name>S</name><script>v1</script>']]));
	const next = pkg([['sys_module', A, '<content>v2</content>'], ['sys_script_include', B, '<name>S</name><script>v2</script>']]);
	const unpullable = (await instanceChangesFromPackage(root, 'dev1', next)).filter((c) => c.generated);
	assert.deepStrictEqual(unpullable.map((c) => c.file), [`sys_module_${A}.xml`]);
	await saveBaselineFromPackage(root, 'dev1', next, undefined, unpullable.map((c) => c.file!));
	const still = await instanceChangesFromPackage(root, 'dev1', next);
	assert.deepStrictEqual(still.map((c) => c.label), [`Server Module ${A}`], 'the module change keeps being reported; the pulled script is settled');
});

test('a record reads as one section per field, without history fields', () => {
	const xml = xmlRecord('sys_ui_page', 'f'.repeat(32), '<description>Todo Board</description><html><![CDATA[<title>A &amp; B</title>\n<body/>]]></html><sys_updated_on>2026-09-27</sys_updated_on>');
	assert.strictEqual(recordForReading(xml), `── description ──\nTodo Board\n\n── html ──\n<title>A &amp; B</title>\n<body/>\n\n── sys_id ──\n${'f'.repeat(32)}\n`);
	assert.strictEqual(recordForReading(undefined), '');
});

test('dismissing an instance change stops reporting it', async () => {
	const root = tmp('snu-dismiss-');
	const A = 'a'.repeat(32), B = 'b'.repeat(32);
	await saveBaselineFromPackage(root, 'dev1', pkg([['sys_ui_page', A, '<description>Board</description><html>v1</html>'], ['sys_script', B, '<name>R</name><script>x</script>']]));
	const records = readPackageRecords(pkg([['sys_ui_page', A, '<description>Board</description><html>v2</html>']]));
	const changes = instanceChangesFromRecords(root, 'dev1', records);
	assert.deepStrictEqual(changes.map((c) => [c.label, c.status]), [['Business Rule R', 'removed'], ['UI Page Board', 'changed']]);
	for (const c of changes) dismissInstanceChange(root, 'dev1', c.file!, records.get(c.file!));
	assert.deepStrictEqual(instanceChangesFromRecords(root, 'dev1', records), []);
	assert.match(readBaselineRecord(root, 'dev1', `sys_ui_page_${A}.xml`)!, /v2/);
});

test('a field the platform fills in by itself (federated_id) is not an instance change', async () => {
	const root = tmp('snu-federated-');
	const A = 'a'.repeat(32);
	await saveBaselineFromPackage(root, 'dev1', pkg([['sys_user_role', A, '<name>x_app.user</name><federated_id/>']]));
	const later = pkg([['sys_user_role', A, '<name>x_app.user</name><federated_id>1c5d27f1dbd0</federated_id>']]);
	assert.deepStrictEqual(await instanceChangesFromPackage(root, 'dev1', later), []);
	writeBuild(root, [['sys_user_role', A, '<name>x_app.user</name>']]);
	assert.deepStrictEqual(deployConflicts(root, 'dev1', later, path.join(root, 'dist', 'app')).overwritten, []);
});

test('undo after a pull also puts back the baseline and the pull marker', async () => {
	const root = tmp('snu-undo-sync-');
	const staged = tmp('snu-undo-sync-staged-');
	const A = 'a'.repeat(32);
	fs.writeFileSync(path.join(root, 'a.ts'), 'mine');
	fs.writeFileSync(path.join(staged, 'a.ts'), 'instance');
	await saveBaselineFromPackage(root, 'dev1', pkg([['sys_script_include', A, '<name>Util</name><script>v1</script>']]));
	const instance = pkg([['sys_script_include', A, '<name>Util</name><script>v2</script>']]);
	assert.strictEqual((await instanceChangesFromPackage(root, 'dev1', instance)).length, 1);

	const undo = applyPullWithUndo(root, staged, [{ path: 'a.ts', status: 'modified' }], 'dev1');
	markPulled(root, 'dev1');
	await saveBaselineFromPackage(root, 'dev1', instance);
	assert.deepStrictEqual(await instanceChangesFromPackage(root, 'dev1', instance), []);

	undoPull(root, undo);
	assert.strictEqual(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'mine');
	assert.strictEqual((await instanceChangesFromPackage(root, 'dev1', instance)).length, 1, 'the instance change is reported again');
	assert.strictEqual(readSyncMarkers(root).pull, null, 'the pull is forgotten');
});

test('whitespace inside a field value counts; line endings and trailing spaces do not', async () => {
	const root = tmp('snu-ws-');
	const A = 'a'.repeat(32);
	const script = "var msg = 'a  b';\n\tif (x) {\n\t\treturn 1;\n\t}";
	await saveBaselineFromPackage(root, 'dev1', pkg([['sys_script_include', A, `<name>Util</name><script>${script}</script>`]]));
	const changes = async (s: string) => (await instanceChangesFromPackage(root, 'dev1', pkg([['sys_script_include', A, `<name>Util</name><script>${s}</script>`]]))).length;
	assert.strictEqual(await changes(script.replace('a  b', 'a b')), 1, 'spaces inside a string');
	assert.strictEqual(await changes(script.replace('\t\treturn', '\treturn')), 1, 'indentation');
	assert.strictEqual(await changes(script.replace(/\n/g, '\r\n')), 0, 'CRLF line endings');
	assert.strictEqual(await changes(script.replace(';\n', ';   \n') + '\n'), 0, 'trailing spaces and a final newline');

	writeBuild(root, [['sys_script_include', A, `<name>Util</name><script>${script}</script>`]]);
	const edited = pkg([['sys_script_include', A, `<name>Util</name><script>${script.replace('a  b', 'a b')}</script>`]]);
	assert.deepStrictEqual(deployConflicts(root, 'dev1', edited, path.join(root, 'dist', 'app')).overwritten.map((c) => c.fields), [['script']]);
});
