import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSetField, recordFieldFiles, updateSetComparisonAccess, previousFieldBaseline, HistoryBaseline } from '../UpdateSetCompare';

const id = 'a'.repeat(32);
const payload = (field: string, action = 'INSERT_OR_UPDATE') => `<record_update><sys_script_include action="${action}"><sys_id>${id}</sys_id>${field}</sys_script_include></record_update>`;
const read = (xml: string) => updateSetField(xml, 'sys_script_include', id, 'script');

test('preserves script whitespace, CDATA, entities, and empty fields', () => {
	assert.equal(read(payload('<script><![CDATA[\n  if (a < b) {}\n]]></script>')), '\n  if (a < b) {}\n');
	assert.equal(read(payload('<script>a &lt; b &amp;&amp; c &#x3e; d</script>')), 'a < b && c > d');
	assert.equal(read(payload('<script/>')), '');
	assert.equal(read(payload('<script><![CDATA[a]]]]><![CDATA[>b]]></script>')), 'a]]>b');
});

test('refuses wrong records, absent fields, deletions, and malformed payloads', () => {
	assert.throws(() => read(payload('<script/>').replace(id, 'b'.repeat(32))), /different record/);
	assert.throws(() => read(payload('<other/>')), /no readable script/);
	assert.throws(() => read(payload('<script/>', 'DELETE')), /deletes/);
	assert.throws(() => read('<broken>'));
	assert.throws(() => read(payload('<script><nested/></script>')), /structured XML/);
});



import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('finds sibling fields without including other modern records or nested records', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-fields-'));
	try {
		for (const name of ['Example.script.js', 'Example.description.txt', 'Other.script.js', '_map.json']) fs.writeFileSync(path.join(dir, name), '');
		const file = path.join(dir, 'Example.script.js');
		assert.deepEqual(recordFieldFiles(file, { name: 'Example', sys_id: id, tableName: 'sys_script_include', fieldName: 'script' }).sort(),
			[file, path.join(dir, 'Example.description.txt')].sort());
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('finds legacy field directories for the same sys_id', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-fields-'));
	try {
		for (const field of ['script', 'description']) {
			fs.mkdirSync(path.join(dir, field));
			fs.writeFileSync(path.join(dir, field, `Example.${id}.js`), '');
			fs.writeFileSync(path.join(dir, field, `Other.${'b'.repeat(32)}.js`), '');
		}
		const file = path.join(dir, 'script', `Example.${id}.js`);
		assert.equal(recordFieldFiles(file, { name: 'Example', sys_id: id, tableName: 'sys_script_include', fieldName: 'script' }).length, 2);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('folder records include their immediate fields and exclude metadata and nested templates', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-fields-'));
	try {
		for (const name of ['script.js', 'template.html', '_widget.json']) fs.writeFileSync(path.join(dir, name), '');
		fs.mkdirSync(path.join(dir, 'sp_ng_template'));
		const file = path.join(dir, 'script.js');
		assert.equal(recordFieldFiles(file, { name: 'Example', sys_id: id, tableName: 'sp_widget', fieldName: 'script' }).length, 2);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('latest-set comparison stays free even before license resolution', () => {
	for (const license of [null, undefined, {}, { licenseResolved: true, proFeatures: false }]) {
		assert.equal(updateSetComparisonAccess(false, false, license), 'allowed');
	}
});

test('advanced comparisons require resolved Pro features for Pro and Trial', () => {
	for (const [choose, allFields] of [[true, false], [true, true], [false, true]]) {
		assert.equal(updateSetComparisonAccess(choose, allFields, null), 'unresolved');
		assert.equal(updateSetComparisonAccess(choose, allFields, { proFeatures: true }), 'unresolved');
		assert.equal(updateSetComparisonAccess(choose, allFields, { licenseResolved: true }), 'proRequired');
		assert.equal(updateSetComparisonAccess(choose, allFields, { licenseResolved: true, proFeatures: false }), 'proRequired');
		assert.equal(updateSetComparisonAccess(choose, allFields, { licenseResolved: true, proFeatures: true }), 'allowed');
	}
});



test('automatic fallback skips current saved field content and malformed snapshots', () => {
	const entry = (id: string, xml: string): HistoryBaseline => ({ id, table: 'sys_update_version', label: 'Saved version', date: '', state: '', link: '', author: '', payload: xml });
	const entries = [entry('current', payload('<script><![CDATA[now\n]]></script>')), entry('unreadable', ''), entry('previous', payload('<script>before</script>'))];
	assert.equal(previousFieldBaseline(entries, 'sys_script_include', id, 'script', 'now\r\n')?.id, 'previous');
	assert.equal(previousFieldBaseline(entries.slice(0, 2), 'sys_script_include', id, 'script', 'now\n'), undefined);
	assert.equal(previousFieldBaseline(entries, 'sys_script_include', id, 'script', 'unsaved edit')?.id, 'current');
});

import { historyDate, sortHistory } from '../UpdateSetCompare';
test('history dates use real timestamps and current version stays above newer customer updates', () => {
	assert.equal(historyDate('sys_update_version', '2026-10-21 12:00:00', '2026-10-22 12:00:00'), '2026-10-21 12:00:00');
	assert.equal(historyDate('sys_update_xml', '', '2026-10-22 12:00:00'), '2026-10-22 12:00:00');
	assert.equal(historyDate('sys_update_version', '1a15f7213240000001', ''), '');
	const row = (id: string, date: string, current = false): HistoryBaseline => ({id, date, current, table: 'sys_update_version', label: id, state: '', link: '', payload: '', author: ''});
	assert.deepEqual(sortHistory([row('older','2026-09-01 12:00:00'), row('newer','2026-10-21 12:00:00'), row('current','2026-10-20 12:00:00',true)]).map(x=>x.id), ['current','newer','older']);
});

import { historyPayloadReader, findHistoryBaseline, historyReadError, historyActionFeedback } from '../UpdateSetCompare';

test('lazy baseline search reads only candidates through the first usable difference and reuses payloads', async () => {
	const row = (key: string): HistoryBaseline => ({id: key, date:'', table:'sys_update_version', label:key, author:'', state:'', link:'', payload:''});
	const entries = [row('same'), row('different'), row('unused')];
	const calls: string[] = [];
	const read = historyPayloadReader(async entry => { calls.push(entry.id); return payload(`<script>${entry.id === 'same' ? 'now' : 'before'}</script>`); });
	assert.equal((await findHistoryBaseline(entries, 'sys_script_include', id, 'script', 'now', read))?.id, 'different');
	assert.deepEqual(calls, ['same', 'different']);
	await Promise.all([read(entries[1]), read(entries[1])]);
	assert.deepEqual(calls, ['same', 'different']);
});

test('denied payload is cached until refresh and does not prevent another source from comparing', async () => {
	const row = (key: string): HistoryBaseline => ({id:key, date:'',table:'sys_update_version',label:key,author:'',state:'',link:'',payload:''});
	const entries = [row('denied'), row('readable')];
	let deniedCalls = 0;
	const read = historyPayloadReader(async entry => {
		if (entry.id === 'denied') { deniedCalls++; throw new Error('HTTP error! status: 403'); }
		return payload('<script>before</script>');
	});
	for (let i=0;i<2;i++) assert.equal((await findHistoryBaseline(entries, 'sys_script_include', id, 'script', 'now', read))?.id, 'readable');
	assert.equal(deniedCalls, 1);
	assert.match(historyReadError('sys_update_version', new Error('HTTP error! status: 403')), /administrator for read access/);
	assert(!historyReadError('sys_update_version', new Error('HTTP error! status: 403')).includes('403'));
});

test('refresh disposal suppresses late feedback and disposal during posting is handled', async () => {
	let disposed = false, posts = 0;
	let finish!: () => void;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	const action = (async () => { await pending; await historyActionFeedback(() => disposed, async () => { posts++; }); })();
	disposed = true;
	finish();
	await action;
	assert.equal(posts, 0);
	await historyActionFeedback(() => false, async () => { throw new Error('Webview is disposed'); });
	await historyActionFeedback(() => false, async () => { posts++; });
	assert.equal(posts, 1);
});
