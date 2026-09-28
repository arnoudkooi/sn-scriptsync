import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { changedFieldNames, deployConflicts, instanceChangesFromPackage, readBuiltRecord, readPackageRecords, recordForReading, saveBaselineFromPackage } from '../NowSdkPull';
import { planAccept } from '../NowSdkAccept';
import { disabledChoiceTables } from '../NowSdkSource';
import { makeZip } from './helpers/zip';

// The nested structure emitted by SDK 4.13, including a same-named wrapper
// and header for v3 and a separate author_elective_update package folder.
const file = 'sys_choice_x_app_todo_category.xml';
type Choice = { value: string; label: string; language?: string; dependent?: string; sequence?: number; inactive?: boolean; id?: string; history?: string; action?: string };
const work: Choice = { value: 'work', label: 'Work', sequence: 1 };
const personal: Choice = { value: 'personal', label: 'Personal', sequence: 2 };
const choicesXml = (choices: Choice[], merge = false, instructions = '') => {
	const wrapper = merge ? 'sys_choice_v2' : 'sys_choice_set';
	return `<record_update><${wrapper} action="INSERT_OR_UPDATE" table="x_app_todo" field="category" version="${merge ? 4 : 3}">
	<sys_choice_set action="INSERT_OR_UPDATE"><sys_id>${'a'.repeat(32)}</sys_id><name>x_app_todo</name><element>category</element></sys_choice_set>
	${instructions}
	${choices.map((c) => `<sys_choice action="${c.action || 'INSERT_OR_UPDATE'}"><sys_id>${c.id || 'b'.repeat(32)}</sys_id><name>x_app_todo</name><element>category</element><value>${c.value}</value><label>${c.label}</label><language>${c.language || 'en'}</language><dependent_value>${c.dependent || ''}</dependent_value><sequence>${c.sequence ?? 1}</sequence><inactive>${c.inactive || false}</inactive>${c.history || ''}</sys_choice>`).join('\n')}
	</${wrapper}></record_update>`;
};
const pkg = (xml: string, folder = 'author_elective_update') => makeZip([{ name: `${folder}/${file}`, content: xml }]);
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snu-choices-test-'));
function build(root: string, xml: string) {
	const app = path.join(root, 'dist', 'app');
	fs.mkdirSync(path.join(app, 'author_elective_update'), { recursive: true });
	fs.writeFileSync(path.join(app, 'author_elective_update', file), xml);
	return app;
}

test('detects added, edited and removed platform choices from either package folder', async (t) => {
	const root = temp();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const before = choicesXml([work, personal]);
	await saveBaselineFromPackage(root, 'dev1', pkg(before));
	assert.strictEqual(readPackageRecords(pkg(before)).get(file), before);
	assert.strictEqual(readBuiltRecord(build(root, before), file), before);
	for (const merge of [false, true]) {
		for (const changed of [
			[work, personal, { value: 'learning', label: 'Learning' }],
			[{ ...work, label: 'Office' }, personal],
			[{ ...work, sequence: 7 }, personal],
			[{ ...work, inactive: true }, personal],
			[{ ...work, language: 'nl' }, personal],
			[{ ...work, dependent: 'urgent' }, personal],
			[personal],
			[],
		]) {
			const xml = choicesXml(changed, merge);
			assert.deepStrictEqual(changedFieldNames(before, xml), ['choices']);
			assert.deepStrictEqual(await instanceChangesFromPackage(root, 'dev1', pkg(xml, 'update')), [{ label: 'Choices x_app_todo.category', status: 'changed', file }]);
		}
	}
});

test('choice comparison ignores XML order, history and regenerated IDs, while keeping translations distinct', () => {
	const dutch = { ...work, label: 'Werk', language: 'nl' };
	const dependent = { ...work, label: 'Urgent work', dependent: 'urgent' };
	const original = choicesXml([work, dutch, dependent, personal]);
	const reordered = choicesXml([personal, dependent, dutch, work].map((c) => ({ ...c, id: 'f'.repeat(32), history: '<sys_mod_count>99</sys_mod_count><sys_updated_on>2026-09-28</sys_updated_on>' })), true);
	assert.deepStrictEqual(changedFieldNames(original, reordered), []);
	assert.ok(recordForReading(original).includes('Urgent work'));
	assert.deepStrictEqual(changedFieldNames(choicesXml([{ value: 'x', label: 'A &amp; B' }]), choicesXml([{ value: 'x', label: '<![CDATA[A & B]]>' }])), []);
	assert.deepStrictEqual(changedFieldNames(choicesXml([work]), choicesXml([{ ...work, label: 'Work  item' }])), ['choices']);
});

test('platform exports with a sys_choice wrapper include every nested choice', async (t) => {
	const root = temp();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const platform = (xml: string) => xml.replace('<sys_choice_set action="INSERT_OR_UPDATE" table=', '<sys_choice action="INSERT_OR_UPDATE" table=').replace('</sys_choice_set></record_update>', '</sys_choice></record_update>');
	const before = choicesXml([work, personal]);
	assert.deepStrictEqual(changedFieldNames(before, platform(before)), []);
	await saveBaselineFromPackage(root, 'dev1', pkg(before));
	const app = build(root, before);
	for (const choices of [[work, { ...personal, label: 'Private' }], [work, personal, { value: 'new', label: 'New' }], [work]]) {
		const after = platform(choicesXml(choices));
		assert.deepStrictEqual(changedFieldNames(before, after), ['choices']);
		assert.strictEqual((await instanceChangesFromPackage(root, 'dev1', pkg(after))).length, 1);
		assert.strictEqual(deployConflicts(root, 'dev1', pkg(after), app).overwritten.length, 1);
	}
});

test('legacy deploy warns about a new choice, and accepting it uses SDK conversion', async (t) => {
	const root = temp();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const before = choicesXml([work]);
	const after = choicesXml([work, personal]);
	await saveBaselineFromPackage(root, 'dev1', pkg(before));
	const app = build(root, before);
	assert.deepStrictEqual(deployConflicts(root, 'dev1', pkg(after, 'update'), app).overwritten.map((c) => c.fields), [['choices']]);
	const plan = planAccept(root, { label: 'Choices x_app_todo.category', status: 'changed', file }, before, after, before);
	assert.deepStrictEqual(plan, { edits: [], pullFields: ['choices'], unresolved: [], edited: [] });
	build(root, after);
	assert.deepStrictEqual(deployConflicts(root, 'dev1', pkg(after), app).overwritten, [], 'already accepted choices are not conflicts');
});

test('deploy compares changed choice fields and understands v4 additions and deletions', async (t) => {
	const root = temp();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	await saveBaselineFromPackage(root, 'dev1', pkg(choicesXml([work])));
	const after = choicesXml([work, personal]);
	const app = build(root, choicesXml([work], true));
	assert.deepStrictEqual(deployConflicts(root, 'dev1', pkg(after), app).overwritten, [], 'a merge leaves an instance-only choice alone');
	build(root, choicesXml([work, { ...personal, action: 'DELETE' }], true));
	assert.deepStrictEqual(deployConflicts(root, 'dev1', pkg(after), app).overwritten.map((c) => c.fields), [['choices']]);
	build(root, choicesXml([work], true, '<sys_choice action="delete_multiple" query="name=x_app_todo^element=category^value=personal^language=en"/>'));
	assert.strictEqual(deployConflicts(root, 'dev1', pkg(after), app).overwritten.length, 1);
	build(root, choicesXml([work], true, '<sys_choice action="delete_multiple" query="name=x_app_todo^element=category^value=other"/>'));
	assert.strictEqual(deployConflicts(root, 'dev1', pkg(after), app).overwritten.length, 0);
	build(root, choicesXml([{ ...work, label: 'Office', sequence: 7 }], true));
	assert.strictEqual(deployConflicts(root, 'dev1', pkg(choicesXml([{ ...work, label: 'Office' }])), app).overwritten.length, 0, 'a local sequence edit does not conflict with an accepted label');
	build(root, choicesXml([work], true));
	assert.strictEqual(deployConflicts(root, 'dev1', pkg(choicesXml([])), app).overwritten.length, 1, 're-creating a choice removed on the instance is a conflict');
});

test('existing baselines still detect choice lists that were previously skipped', async (t) => {
	const root = temp();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	await saveBaselineFromPackage(root, 'dev1', makeZip([{ name: 'update/keep.xml', content: '<record_update><sys_script><name>Keep</name></sys_script></record_update>' }]));
	const xml = choicesXml([work]);
	const changes = await instanceChangesFromPackage(root, 'dev1', pkg(xml));
	assert.ok(changes.some((c) => c.file === file && c.status === 'new'));
	const app = build(root, xml);
	assert.deepStrictEqual(deployConflicts(root, 'dev1', pkg(xml), app).overwritten, [], 'a previously untracked list that matches the build does not block deployment');
	assert.strictEqual(deployConflicts(root, 'dev1', pkg(choicesXml([work, personal])), app).overwritten.length, 1);
});

test('v4 deletion selectors retain metadata without reporting it as a change', async (t) => {
	const root = temp();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const current = { ...personal, history: '<sys_scope>scope123</sys_scope><sys_update_name>choice123</sys_update_name>' };
	await saveBaselineFromPackage(root, 'dev1', pkg(choicesXml([work])));
	const after = choicesXml([work, current]);
	for (const query of ['value=personal^sys_scope=scope123^sys_update_name=choice123', `value=personal^sys_id=${'b'.repeat(32)}`, 'value=personal^undocumented_selector=x']) {
		const app = build(root, choicesXml([work], true, `<sys_choice action="delete_multiple" query="${query}"/>`));
		assert.strictEqual(deployConflicts(root, 'dev1', pkg(after), app).overwritten.length, 1, query);
	}
	const app = build(root, choicesXml([work], true, '<sys_choice action="delete_multiple" query="value=personal^sys_scope=another_scope"/>'));
	assert.strictEqual(deployConflicts(root, 'dev1', pkg(after), app).overwritten.length, 0);
});

test('sync-disabled Table choices stay pending instead of being acknowledged by Pull or Accept', async (t) => {
	const root = temp();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = "export const table = Table({ name: 'x_app_todo', schema: { category: ChoiceColumn({ choices: { work: { label: 'Work' } } }) } })";
	const before = choicesXml([work]), after = choicesXml([work, personal]);
	const app = build(root, before);
	const filename = path.join(root, 'src', 'app.now.ts');
	fs.mkdirSync(path.dirname(filename), { recursive: true });
	for (const text of [
		'// @fluent-disable-sync-for-file\n' + source,
		'// @fluent-disable-sync\n' + source,
		source.replace('category:', '\n// @fluent-disable-sync\ncategory:'),
		"import { Table as T } from '@servicenow/sdk/core'\n// @fluent-disable-sync\n" + source.replace('Table(', 'T('),
		"// @fluent-disable-sync\nChoiceSet({table:'x_app_todo',field:'category',choices:{work:{label:'Work'}}})",
		"import { ChoiceSet as Choices } from '@servicenow/sdk/core'\n// @fluent-disable-sync-for-file\nChoices({table:'x_app_todo',field:'category',choices:{work:{label:'Work'}}})",
	]) {
		fs.writeFileSync(filename, text);
		await saveBaselineFromPackage(root, 'dev1', pkg(before));
		const changes = await instanceChangesFromPackage(root, 'dev1', pkg(after));
		assert.strictEqual(changes[0].generated, true);
		const plan = planAccept(root, changes[0], before, after, before);
		assert.deepStrictEqual(plan.pullFields, []);
		assert.strictEqual(plan.unresolved.length, 1);
		await saveBaselineFromPackage(root, 'dev1', pkg(after), undefined, changes.filter((c) => c.generated).map((c) => c.file!));
		assert.strictEqual(deployConflicts(root, 'dev1', pkg(after), app).overwritten.length, 1);
	}
	assert.deepStrictEqual([...disabledChoiceTables(root, filename, "// @fluent-disable-sync\nBusinessRule({name:'Other'})\n" + source)], [], 'a marker on another definition does not block this Table');
});

test('conflicting duplicate package entries cannot silently mask a choice list', () => {
	assert.throws(() => readPackageRecords(makeZip([
		{ name: `update/${file}`, content: choicesXml([work]) },
		{ name: `author_elective_update/${file}`, content: choicesXml([personal]) },
	])), /conflicting copies/);
});
