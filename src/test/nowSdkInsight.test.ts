import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { filesEditedSince, readAppContents, relativeTime } from '../NowSdkInsight';
import { markDeployed, readSyncMarkers } from '../NowSdkPull';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snu-insight-'));
const record = (table: string, sysId: string, fields: string) =>
	`<?xml version="1.0"?><record_update table="${table}"><${table} action="INSERT_OR_UPDATE"><sys_id>${sysId}</sys_id>${fields}</${table}></record_update>`;

test('lists the built app by record type with names and instance links', () => {
	const app = tmp();
	const update = path.join(app, 'update');
	fs.mkdirSync(update, { recursive: true });
	const write = (file: string, xml: string) => fs.writeFileSync(path.join(update, file), xml);
	write('sys_db_object_1.xml', record('sys_db_object', '1'.repeat(32), '<label>Todo</label><name>x_a_todo</name>'));
	write('sys_dictionary_a.xml', record('sys_dictionary', '2'.repeat(32), '<name>x_a_todo</name><element>due</element>'));
	write('sys_dictionary_b.xml', record('sys_dictionary', '3'.repeat(32), '<name>x_a_todo</name><element/>'));
	write('sys_ui_page_1.xml', record('sys_ui_page', '4'.repeat(32), '<description>Todo Board</description><name>board</name><endpoint>x_a_board.do</endpoint>'));
	write('sys_security_acl_1.xml', record('sys_security_acl', '5'.repeat(32), '<name>x_a_todo</name><operation display_value="read">read</operation>'));
	write('sys_module_1.xml', record('sys_module', '6'.repeat(32), '<path>x_a/app/0.0.1/src/server/rules.ts</path>'));
	write('sys_module_2.xml', record('sys_module', '7'.repeat(32), '<path>x_a/app/0.0.1/bom.json</path>'));
	write('sys_documentation_1.xml', record('sys_documentation', '8'.repeat(32), '<label>ignored</label>'));
	write('sys_script_include_1.xml', record('sys_script_include', '9'.repeat(32), '<name><![CDATA[Util & Co]]></name>'));

	const groups = readAppContents(app);
	assert.deepStrictEqual(groups.map((g) => [g.label, g.records.map((r) => r.name)]), [
		['Tables', ['Todo']],
		['Columns', ['x_a_todo.due']],
		['UI Pages', ['Todo Board']],
		['Script Includes', ['Util & Co']],
		['ACLs', ['x_a_todo (read)']],
		['Server Modules', ['rules.ts']],
	]);
	assert.strictEqual(groups[2].records[0].link, 'x_a_board.do', 'a UI page opens the page itself');
	assert.strictEqual(groups[0].records[0].link, `sys_db_object.do?sys_id=${'1'.repeat(32)}`);
	assert.deepStrictEqual(readAppContents(path.join(app, 'missing')), []);
});

test('files edited since the last deploy leave out build output and keys.ts', () => {
	const root = tmp();
	for (const file of ['src/a.ts', 'src/fluent/generated/keys.ts', 'dist/app/x.xml', 'old.ts']) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), 'x');
	}
	const past = new Date(Date.now() - 3600_000);
	fs.utimesSync(path.join(root, 'old.ts'), past, past);
	const since = new Date(Date.now() - 60_000).toISOString();
	assert.deepStrictEqual(filesEditedSince(root, since), ['src/a.ts']);
	assert.deepStrictEqual(filesEditedSince(root, 'not a date'), []);
});

test('deploy markers are recorded and read back', () => {
	const root = tmp();
	assert.deepStrictEqual(readSyncMarkers(root), { deploy: null, pull: null });
	markDeployed(root, 'dev1');
	const { deploy } = readSyncMarkers(root);
	assert.strictEqual(deploy?.instance, 'dev1');
	assert.ok(Date.now() - Date.parse(deploy!.at) < 5000);
});

test('relative times read naturally', () => {
	const now = Date.parse('2026-09-27T12:00:00Z');
	const ago = (ms: number) => new Date(now - ms).toISOString();
	assert.strictEqual(relativeTime(ago(10_000), now), 'just now');
	assert.strictEqual(relativeTime(ago(5 * 60_000), now), '5 min ago');
	assert.strictEqual(relativeTime(ago(3 * 3600_000), now), '3 h ago');
	assert.strictEqual(relativeTime(ago(26 * 3600_000), now), 'yesterday');
	assert.strictEqual(relativeTime(ago(4 * 86400_000), now), '4 days ago');
	assert.strictEqual(relativeTime('nope', now), '');
});
