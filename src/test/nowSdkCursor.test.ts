import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { indexSourceDefinitions, parseKeysFile, recordAtOffset, recordFileName, recordsInSource } from '../NowSdkCursor';

const id = (c: string) => c.repeat(32);

const keysTs = `
declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    sync_rule: {
                        table: 'sys_script'
                        id: '${id('a')}'
                    }
                    'old-rule': {
                        table: 'sys_script'
                        id: '${id('b')}'
                        deleted: true
                    }
                }
                composite: [
                    {
                        table: 'sys_db_object'
                        id: '${id('c')}'
                        key: {
                            name: 'x_app_todo'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '${id('d')}'
                        key: {
                            name: 'x_app_todo'
                            element: 'due'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '${id('e')}'
                        key: {
                            name: 'x_app.user'
                        }
                    },
                ]
            }
        }
    }
}
`;

const source = `import { BusinessRule, DateColumn, Role, Table } from '@servicenow/sdk/core'

export const user = Role({
    $id: Now.ID['user_role'],
    name: 'x_app.user',
})

export const x_app_todo = Table({
    name: 'x_app_todo',
    schema: {
        due: DateColumn({ label: 'Due date' }),
        notes: DateColumn({ label: 'Not built yet' }),
    },
})

BusinessRule({
    $id: Now.ID['sync_rule'],
    name: 'Sync',
    table: 'x_app_todo',
})

BusinessRule({
    $id: Now.ID['new_rule'],
    name: 'Not built yet',
})
`;

test('keys.ts: explicit and composite entries, deleted ones left out', () => {
	const keys = parseKeysFile(keysTs);
	assert.deepStrictEqual([...keys.explicit], [['sync_rule', { table: 'sys_script', id: id('a') }]]);
	assert.deepStrictEqual(keys.composite.map((c) => [c.table, c.key]), [
		['sys_db_object', { name: 'x_app_todo' }],
		['sys_dictionary', { name: 'x_app_todo', element: 'due' }],
		['sys_user_role', { name: 'x_app.user' }],
	]);
});

test('definitions map to their records: by Now.ID, by matching fields, and columns by table and element', () => {
	const records = recordsInSource(ts, 'a.now.ts', source, parseKeysFile(keysTs));
	assert.deepStrictEqual(records.map((r) => [r.label, recordFileName(r)]), [
		// Now.ID['user_role'] is not in keys.ts: the SDK matches the role on its name.
		['Role x_app.user', `sys_user_role_${id('e')}.xml`],
		['Table x_app_todo', `sys_db_object_${id('c')}.xml`],
		['Column x_app_todo.due', `sys_dictionary_${id('d')}.xml`],
		['BusinessRule Sync', `sys_script_${id('a')}.xml`],
	]);
});

test('the cursor picks the innermost definition around it', () => {
	const records = recordsInSource(ts, 'a.now.ts', source, parseKeysFile(keysTs));
	assert.strictEqual(recordAtOffset(records, source.indexOf("label: 'Due date'"))?.label, 'Column x_app_todo.due');
	assert.strictEqual(recordAtOffset(records, source.indexOf("label: 'Not built yet'"))?.label, 'Table x_app_todo');
	assert.strictEqual(recordAtOffset(records, source.indexOf("table: 'x_app_todo'"))?.label, 'BusinessRule Sync');
	assert.strictEqual(recordAtOffset(records, source.indexOf("name: 'Not built yet'")), undefined, 'a definition without an ID yet');
	assert.strictEqual(recordAtOffset(records, 0), undefined);
});

test('the app index points each record at its definition, and server modules at their file', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-cursor-'));
	const write = (file: string, content: string) => {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), content);
	};
	write('src/fluent/generated/keys.ts', keysTs.replace("explicit: {", `explicit: {\n'src_server_rules_ts': {\ntable: 'sys_module'\nid: '${id('f')}'\n}`));
	write('src/fluent/app.now.ts', source);
	write('src/server/rules.ts', 'export function sync() {}');
	const index = indexSourceDefinitions(ts, root);
	assert.deepStrictEqual(index.get(id('d')), { file: 'src/fluent/app.now.ts', start: source.indexOf('due: DateColumn') });
	assert.deepStrictEqual(index.get(id('a')), { file: 'src/fluent/app.now.ts', start: source.indexOf("BusinessRule({\n    $id: Now.ID['sync_rule']") });
	assert.deepStrictEqual(index.get(id('f')), { file: 'src/server/rules.ts', start: 0 });
});
