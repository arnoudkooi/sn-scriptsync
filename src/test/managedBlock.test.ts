import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHarness, stubVscode } from './helpers/commandHarness';

const harness = createHarness();
stubVscode(harness.workspaceRoot);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ExtensionUtils } = require('../ExtensionUtils');
const eu = new ExtensionUtils();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-marker-'));
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function upsert(source: string, dest: string, preserveUserFile = true): Promise<void> {
	return new Promise((resolve, reject) => {
		eu.upsertManagedBlock(source, dest, (err: any) => (err ? reject(err) : resolve()), { preserveUserFile });
	});
}

function write(name: string, content: string): string {
	const p = path.join(dir, name);
	fs.writeFileSync(p, content);
	return p;
}

const NEW_BLOCK = [
	'<!-- SN-SCRIPTSYNC:BEGIN instructionsSchemaVersion=22 -->',
	'fresh managed content',
	'<!-- SN-SCRIPTSYNC:END -->',
].join('\n');

// ---------------------------------------------------------------------------
// The rename's whole risk. Workspaces in the field carry `apiVersion=N`. A
// regex that only knew the new name would fail to find the existing block and
// APPEND a second one, silently doubling the managed section in someone's
// CLAUDE.md on the next refresh.
// ---------------------------------------------------------------------------

test('a block written with the OLD apiVersion marker is replaced, not duplicated', async () => {
	const source = write('src-old.md', NEW_BLOCK);
	const dest = write(
		'CLAUDE-old.md',
		[
			'# My own notes',
			'keep me',
			'',
			'<!-- SN-SCRIPTSYNC:BEGIN apiVersion=21 -->',
			'stale managed content',
			'<!-- SN-SCRIPTSYNC:END -->',
		].join('\n')
	);

	await upsert(source, dest);
	const out = fs.readFileSync(dest, 'utf8');

	const begins = (out.match(/SN-SCRIPTSYNC:BEGIN/g) || []).length;
	assert.strictEqual(begins, 1, 'the old block must be replaced, never joined by a second');
	assert.ok(out.includes('# My own notes') && out.includes('keep me'), 'user content survives');
	assert.ok(out.includes('fresh managed content'));
	assert.ok(!out.includes('stale managed content'));
});

test('a block written with the NEW marker is also replaced in place', async () => {
	const source = write('src-new.md', NEW_BLOCK);
	const dest = write(
		'CLAUDE-new.md',
		['user text', '<!-- SN-SCRIPTSYNC:BEGIN instructionsSchemaVersion=21 -->', 'old', '<!-- SN-SCRIPTSYNC:END -->'].join('\n')
	);

	await upsert(source, dest);
	const out = fs.readFileSync(dest, 'utf8');

	assert.strictEqual((out.match(/SN-SCRIPTSYNC:BEGIN/g) || []).length, 1);
	assert.ok(out.includes('user text'));
	assert.ok(!out.includes('\nold\n'));
});

test('a file with no managed block gains exactly one', async () => {
	const source = write('src-append.md', NEW_BLOCK);
	const dest = write('CLAUDE-none.md', '# Just my notes\n');

	await upsert(source, dest);
	const out = fs.readFileSync(dest, 'utf8');

	assert.strictEqual((out.match(/SN-SCRIPTSYNC:BEGIN/g) || []).length, 1);
	assert.ok(out.includes('# Just my notes'), 'the user file is appended to, never replaced');
});

test('refreshing twice is idempotent under either marker spelling', async () => {
	const source = write('src-twice.md', NEW_BLOCK);
	const dest = write(
		'CLAUDE-twice.md',
		['mine', '<!-- SN-SCRIPTSYNC:BEGIN apiVersion=21 -->', 'x', '<!-- SN-SCRIPTSYNC:END -->'].join('\n')
	);

	await upsert(source, dest);
	const once = fs.readFileSync(dest, 'utf8');
	await upsert(source, dest);
	const twice = fs.readFileSync(dest, 'utf8');

	assert.strictEqual(once, twice, 'a second refresh must change nothing');
	assert.strictEqual((twice.match(/SN-SCRIPTSYNC:BEGIN/g) || []).length, 1);
});
