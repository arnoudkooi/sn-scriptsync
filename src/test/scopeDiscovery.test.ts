import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverScopeFields, pageState, readAllPages, FetchPage } from '../ScopeDiscovery';

test('short and empty ACL-filtered pages do not end a metadata load', async () => {
    const offsets: string[] = [];
    const result = await readAllPages(async (_table, query) => {
        offsets.push(query.sysparm_offset);
        const offset = Number(query.sysparm_offset);
        return {
            rows: offset === 0 ? [{ sys_class_name: 'sys_transform_entry' }] : offset === 500 ? [] : [{ sys_class_name: 'catalog_script_client' }],
            pagination: { totalCount: '1001' },
        };
    }, 'sys_metadata', 'sys_scope=test^ORDERBYsys_id', 'sys_class_name');
    assert.deepEqual(offsets, ['0', '500', '1000']);
    assert.equal(result.complete, true);
    assert.deepEqual(result.rows.map(r => r.sys_class_name), ['sys_transform_entry', 'catalog_script_client']);
});

test('large applications reach later portal and catalog tables beyond 18,393 readable records', async () => {
    const result = await readAllPages(async (_table, query) => {
        const offset = Number(query.sysparm_offset);
        const count = offset === 18000 ? 393 : offset === 18500 ? 0 : Math.min(500, 52001 - offset);
        return {
            rows: Array.from({ length: count }, (_, i) => ({ sys_id: offset + i, sys_class_name: offset < 19000 ? 'sys_transform_entry' : 'sp_widget' })),
            pagination: { totalCount: '52001' },
        };
    }, 'sys_metadata', 'sys_scope=test^ORDERBYsys_id', 'sys_id,sys_class_name');
    assert.equal(result.complete, true);
    assert.equal(result.rows.at(-1)?.sys_id, 52000);
    assert.ok(result.rows.some(r => r.sys_class_name === 'sp_widget'));
});

test('server next links control offsets without changing the table or forwarding their URLs', () => {
    assert.deepEqual(pageState({ link: '<https://untrusted.invalid/?sysparm_offset=900>; rel="next"' }, 0, 500, 0), { nextOffset: 900, complete: false });
    assert.equal(pageState({ link: '<https://instance/?sysparm_offset=0>; rel="first"' }, 900, 500, 2).complete, true);
    assert.throws(() => pageState({ link: '<https://instance/?sysparm_offset=0>; rel="next"' }, 0, 500, 0), /Invalid next-page/);
    assert.throws(() => pageState({ link: '<https://instance/?other=1>; rel="next"' }, 0, 500, 0), /Invalid next-page/);
});

test('old helpers never turn an unverified short or empty page into success', () => {
    for (const count of [0, 193]) {
        const result = pageState(undefined, 18000, 200, count);
        assert.equal(result.complete, false);
        assert.match(result.warning!, /Update SN Utils/);
    }
    assert.deepEqual(pageState(undefined, 0, 200, 200), { complete: false, nextOffset: 200 });
});

const field = (name: string, element: string, type: string) => ({ name, element, 'internal_type.name': type, column_label: element });
test('instance fields cover unknown tables, inherited fields, overrides and reference-only tables', async () => {
    const parents = [
        { name: 'x_custom_widget', 'super_class.name': 'sp_widget' },
        { name: 'sp_theme', 'super_class.name': '' },
        { name: 'sp_widget', 'super_class.name': '' },
    ];
    const fields = [field('sp_widget', 'script', 'script'), field('sp_widget', 'template', 'html_template'),
        field('x_custom_widget', 'style', 'css'), field('x_custom_widget', 'script', 'string'), field('sp_theme', 'header', 'reference')];
    const fetch: FetchPage = async (table, q) => {
        const rows = table === 'sys_db_object' ? parents.filter(r => q.sysparm_query.split('^')[0].slice(6).split(',').includes(r.name)) : fields;
        return { rows, pagination: { totalCount: String(rows.length) } };
    };
    const schema = await discoverScopeFields(['x_custom_widget', 'sp_theme'], { x_custom_widget: { group: 'portal' } }, fetch);
    assert.deepEqual(Object.keys(schema.definitions.x_custom_widget.codeFields!).sort(), ['style', 'template']);
    assert.equal(schema.definitions.x_custom_widget.codeFields!.template.type, 'html_template');
    assert.equal(schema.definitions.x_custom_widget.group, 'portal');
    assert.deepEqual(schema.definitions.sp_theme.codeFields, {});
    assert.deepEqual(schema.warnings, []);
});

test('unreadable dictionary uses a warned fallback without modifying the bundled definitions', async () => {
    const bundled = { catalog_script_client: { codeFields: { script: { label: 'Script', type: 'script' } } } };
    const schema = await discoverScopeFields(['catalog_script_client', 'x_unknown'], bundled, async () => { throw new Error('Access denied'); });
    assert.deepEqual(schema.definitions.catalog_script_client.codeFields, bundled.catalog_script_client.codeFields);
    assert.equal(schema.warnings.length, 2);
    assert.match(schema.warnings[0], /Access denied/);
    schema.definitions.catalog_script_client.codeFields!.script.label = 'Edited';
    assert.equal(bundled.catalog_script_client.codeFields.script.label, 'Script');
});

test('independently packaged hosts use identical discovery and paging logic', () => {
    const root = resolve(__dirname, '../..');
    assert.equal(readFileSync(resolve(root, 'src/ScopeDiscovery.ts'), 'utf8'), readFileSync(resolve(root, 'packages/snu/src/server/scopeDiscovery.ts'), 'utf8'));
});
