import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addOverride, patchIntoSource, planAccept } from '../NowSdkAccept';

test('a change to built HTML lands in the source file, despite different blank lines', () => {
	const source = '<html>\n<head>\n  <title>Todo Board</title>\n\n  <!-- globals -->\n  <script src="./main.tsx"></script>\n</head>\n</html>\n';
	const built = '<html>\n  <head>\n    <title>Todo Board</title>\n    <!-- globals -->\n    <script src="main.jsdbx"></script>\n  </head>\n</html>';
	const res = patchIntoSource(new Map([['src/client/index.html', source], ['src/other.ts', 'const a = 1']]), built, built.replace('Todo Board', 'Todo Board by Arnoud'));
	assert.strictEqual(res?.file, 'src/client/index.html');
	assert.strictEqual(res?.content, source.replace('<title>Todo Board</title>', '<title>Todo Board by Arnoud</title>'));
});

test('a change whose text appears in several places is not guessed', () => {
	const files = new Map([['a.ts', 'return true\nreturn true\n'], ['b.ts', 'x']]);
	assert.strictEqual(patchIntoSource(files, 'return true', 'return false'), null);
	assert.strictEqual(patchIntoSource(new Map([['a.ts', 'nothing']]), 'same', 'same'), null);
});

test('new lines take the indentation of the source file', () => {
	const source = 'function f() {\n\tconst x = 1\n\treturn x\n}\n';
	const compiled = 'function f() {\n    const x = 1;\n    return x;\n}';
	const res = patchIntoSource(new Map([['src/server/f.ts', source]]), compiled.replace(/;/g, ''), 'function f() {\n    const x = 1\n    log(x)\n    return x\n}');
	assert.strictEqual(res?.content, 'function f() {\n\tconst x = 1\n\tlog(x)\n\treturn x\n}\n');
});

test('$override is created on the definition, or extended when present', () => {
	const fluent = "BusinessRule({\n    $id: Now.ID['sync_rule'],\n    name: 'Sync',\n})\n\nBusinessRule({\n    $id: Now.ID['other'],\n    $override: { u_a: 'x' },\n})\n";
	const files = new Map([['src/fluent/rules.now.ts', fluent]]);
	assert.strictEqual(addOverride(files, 'sync_rule', 'abort_action', 'true')?.content,
		fluent.replace("$id: Now.ID['sync_rule'],", "$id: Now.ID['sync_rule'],\n    $override: { abort_action: true },"));
	assert.strictEqual(addOverride(files, 'other', 'message', 'Hello')?.content, fluent.replace("$override: { u_a: 'x' }", "$override: { message: \"Hello\", u_a: 'x' }"));
	assert.strictEqual(addOverride(files, 'other', 'u_a', 'y')?.content, fluent.replace("u_a: 'x'", 'u_a: "y"'));
	assert.strictEqual(addOverride(files, 'missing', 'x', '1'), null);
});

test('$override is placed with the TypeScript parser: commas in strings, comments and nesting are safe', () => {
	const fluent = [
		'// Now.ID[\'rule\'] in a comment is not a definition',
		'BusinessRule({',
		'    $id: Now.ID[\'rule\'],',
		'    $override: { message: \'a, b }, c\', u_x: 1 },',
		'    condition: \'{ a: 1 }\',',
		'})',
		'',
		'Table({',
		'    name: \'x\',',
		'    $id: Now.ID[\'last\']',
		'})',
		'',
		'Role({ $id: Now.ID[\'empty\'], $override: {} })',
		'',
		'Role({ $id: Now.ID[\'shared\'], $override: sharedOverrides })',
		'',
	].join('\n');
	const files = new Map([['src/fluent/a.now.ts', fluent]]);
	assert.strictEqual(addOverride(files, 'rule', 'message', 'x, y')?.content, fluent.replace("message: 'a, b }, c'", 'message: "x, y"'));
	assert.strictEqual(addOverride(files, 'rule', 'u_x', '2')?.content, fluent.replace('u_x: 1', 'u_x: 2'));
	assert.strictEqual(addOverride(files, 'rule', 'active', 'false')?.content, fluent.replace('$override: { message', '$override: { active: false, message'));
	assert.strictEqual(addOverride(files, 'last', 'u_y', 'z')?.content, fluent.replace("$id: Now.ID['last']", "$id: Now.ID['last'],\n    $override: { u_y: \"z\" }"));
	assert.strictEqual(addOverride(files, 'empty', 'u_y', 'z')?.content, fluent.replace("$override: {} })", "$override: { u_y: \"z\" } })"));
	assert.strictEqual(addOverride(files, 'shared', 'u_y', 'z'), null, 'an $override kept elsewhere is not edited');
	assert.strictEqual(addOverride(files, 'rule', 'x', '1', null), null, 'without the parser nothing is guessed');
});

test('a plan uses what the editor shows, saved or not', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-accept-open-'));
	fs.mkdirSync(path.join(root, 'src', 'client'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src/client/index.html'), '<head>\n  <title>Board</title>\n</head>\n');
	const id = 'b'.repeat(32);
	const rec = (html: string) => `<record_update table="sys_ui_page"><sys_ui_page action="INSERT_OR_UPDATE"><sys_id>${id}</sys_id><html><![CDATA[${html}]]></html></sys_ui_page></record_update>`;
	const page = { label: 'UI Page Board', status: 'changed' as const, generated: true, reason: 'built from your UI source', file: `sys_ui_page_${id}.xml` };
	const unsaved = '<head>\n  <title>Board</title>\n  <meta name="unsaved">\n</head>\n';
	const plan = planAccept(root, page, rec('<head>\n    <title>Board</title>\n</head>'), rec('<head>\n    <title>Board 2</title>\n</head>'), undefined,
		{ openFiles: new Map([['src/client/index.html', unsaved]]) });
	assert.deepStrictEqual(plan.edits.map((e) => e.content), [unsaved.replace('Board<', 'Board 2<')], 'the unsaved line is kept');
	assert.deepStrictEqual(plan.edited, ['html']);
});

test('plans per field: patch generated content, pull converted fields, override unsupported ones', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-accept-'));
	const write = (file: string, content: string) => {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), content);
	};
	const id = 'a'.repeat(32);
	write('src/fluent/generated/keys.ts', `explicit: {\n  sync_rule: {\n    table: 'sys_script'\n    id: '${id}'\n  }\n}`);
	write('src/fluent/rules.now.ts', "BusinessRule({\n    $id: Now.ID['sync_rule'],\n    name: 'Sync',\n})\n");
	write('src/client/index.html', '<head>\n  <title>Board</title>\n</head>\n');
	const rec = (table: string, fields: string) => `<record_update table="${table}"><${table} action="INSERT_OR_UPDATE"><sys_id>${id}</sys_id>${fields}</${table}></record_update>`;

	const rule = { label: 'Business Rule Sync', status: 'changed' as const, file: `sys_script_${id}.xml` };
	const plan = planAccept(root, rule,
		rec('sys_script', '<name>Sync</name><script>a</script><abort_action>false</abort_action>'),
		rec('sys_script', '<name>Sync</name><script>b</script><abort_action>true</abort_action>'),
		rec('sys_script', '<name>Sync</name><script>a</script>'));
	assert.deepStrictEqual(plan.pullFields, ['script']);
	assert.deepStrictEqual(plan.edits.map((e) => [e.file, e.what]), [['src/fluent/rules.now.ts', 'Business Rule Sync: abort_action (as $override)']]);
	assert.match(plan.edits[0].content, /\$override: \{ abort_action: true \}/);

	const page = { label: 'UI Page Board', status: 'changed' as const, generated: true, reason: 'built from your UI source', file: `sys_ui_page_${id}.xml` };
	const html = (t: string) => rec('sys_ui_page', `<html><![CDATA[<head>\n<title>${t}</title>\n</head>]]></html>`);
	const pagePlan = planAccept(root, page, html('Board'), html('Board v2'), html('Board'));
	assert.deepStrictEqual(pagePlan.edits.map((e) => e.file), ['src/client/index.html']);
	assert.match(pagePlan.edits[0].content, /<title>Board v2<\/title>/);

	const mod = { label: 'Server Module x.js', status: 'changed' as const, generated: true, reason: 'compiled from your server source', file: `sys_module_${id}.xml` };
	const modPlan = planAccept(root, mod, rec('sys_module', '<content>minified();</content>'), rec('sys_module', '<content>minified(2);</content>'), rec('sys_module', '<content>minified();</content>'));
	assert.deepStrictEqual(modPlan.unresolved.map((u) => u.field), ['content']);

	const gone = planAccept(root, { ...rule, status: 'removed' }, rec('sys_script', '<name>Sync</name>'), undefined, undefined);
	assert.match(gone.unresolved[0].why, /deleted on the instance/);
});

test('an edit saved through the platform form (CRLF, reflowed blank lines) still lands as one line', () => {
	const source = '<html>\n<head>\n  <title>Todo Board</title>\n\n  <sdk:now-ux-globals></sdk:now-ux-globals>\n  <script src="./main.tsx"></script>\n</head>\n</html>\n';
	const stored = '\n<!-- @fluent-import-html WARNING -->\n<html>\n  <head>\n    <title>Todo Board</title>\n    <script>window.NOW = {};</script>\n    <sdk:now-ux-globals></sdk:now-ux-globals>\n  </head>\n</html>';
	const saved = stored.trimStart().replace('Todo Board', 'Todo Board by AK').replace(/\n/g, '\r\n');
	const res = patchIntoSource(new Map([['src/client/index.html', source]]), stored, saved);
	assert.strictEqual(res?.content, source.replace('<title>Todo Board</title>', '<title>Todo Board by AK</title>'));
});

test('separate edits land as separate hunks, each in its place', () => {
	const source = 'const a = 1\nconst b = 2\nfunction keep() {}\nconst c = 3\nconst d = 4\n';
	const built = 'var a = 1;\nconst b = 2\nfunction keep() {}\nconst c = 3\nconst d = 4';
	const edited = built.replace('const b = 2', 'const b = 20').replace('const d = 4', 'const d = 40');
	assert.strictEqual(patchIntoSource(new Map([['x.ts', source]]), built, edited)?.content, source.replace('const b = 2', 'const b = 20').replace('const d = 4', 'const d = 40'));
});
