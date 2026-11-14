import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverScopeFields, pageState, readAllPages, FetchPage, MAX_PAGES } from '../ScopeDiscovery';

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

test('the stored type name is used when its sys_glide_object record is missing', async () => {
    // Seen live: sys_db_object.sys_class_code has internal_type "sys_class_code"
    // with no sys_glide_object record, so the dot-walked name comes back empty.
    const fetch: FetchPage = async (table) => table === 'sys_db_object'
        ? { rows: [{ name: 'sys_db_object', 'super_class.name': '' }], pagination: { totalCount: '1' } }
        : { rows: [
            { name: 'sys_db_object', element: 'sys_class_code', internal_type: 'sys_class_code', 'internal_type.name': '' },
            { name: 'sys_db_object', element: 'script', internal_type: 'script' },
        ], pagination: { totalCount: '2' } };
    const schema = await discoverScopeFields(['sys_db_object'], {}, fetch);
    assert.deepEqual(schema.warnings, []);
    assert.ok(schema.established.has('sys_db_object'));
    assert.deepEqual(Object.keys(schema.definitions.sys_db_object.codeFields!), ['script']);
});

test('a failed dictionary batch affects only the tables it covers', async () => {
    const tables = Array.from({ length: 101 }, (_, i) => `x_t${String(i).padStart(3, '0')}`);
    const fetch: FetchPage = async (table, q) => {
        const names = q.sysparm_query.split('^')[0].slice(6).split(',');
        if (table === 'sys_db_object') return { rows: names.map(name => ({ name, 'super_class.name': '' })), pagination: { totalCount: String(names.length) } };
        if (names.includes('x_t100')) throw new Error('Transaction cancelled: maximum execution time exceeded');
        return { rows: names.map(name => ({ name, element: 'script', internal_type: 'script' })), pagination: { totalCount: String(names.length) } };
    };
    const schema = await discoverScopeFields(tables, {}, fetch);
    assert.equal(schema.established.size, 100);
    assert.ok(!schema.established.has('x_t100'));
    assert.equal(schema.warnings.length, 1);
    assert.match(schema.warnings[0], /^x_t100: Dictionary discovery failed: Transaction cancelled/);
    assert.deepEqual(Object.keys(schema.definitions.x_t000.codeFields!), ['script']);
});

test('an incomplete dictionary read marks its tables failed; an incomplete inheritance read is still used', async () => {
    const fetch: FetchPage = async (table) => table === 'sys_db_object'
        // One row the count says exists was not returned (access controls).
        ? { rows: [{ name: 'x_a', 'super_class.name': '' }, { name: 'x_b', 'super_class.name': '' }], pagination: { totalCount: '3' } }
        : { rows: [{ name: 'x_a', element: 'script', internal_type: 'script' }], pagination: { totalCount: '5' } };
    const schema = await discoverScopeFields(['x_a', 'x_b', 'x_c'], {}, fetch);
    assert.equal(schema.established.size, 0, 'missing dictionary rows could hide script fields');
    assert.match(schema.warnings.find(w => w.startsWith('x_a:'))!, /Dictionary discovery was incomplete/);
    assert.match(schema.warnings.find(w => w.startsWith('x_c:'))!, /Table inheritance discovery was incomplete/);
});

test('without paging headers the instance count decides whether a short read is complete', async () => {
    const rows = [{ sys_class_name: 'sp_widget' }, { sys_class_name: 'sys_script' }];
    const fetch: FetchPage = async () => ({ rows });
    const counted: string[] = [];
    const exact = await readAllPages(fetch, 'sys_metadata', 'sys_scope=x^ORDERBYsys_id', 'sys_class_name', async (table, query) => { counted.push(`${table}|${query}`); return 2; });
    assert.equal(exact.complete, true);
    assert.deepEqual(exact.warnings, []);
    assert.deepEqual(counted, ['sys_metadata|sys_scope=x^ORDERBYsys_id']);

    const more = await readAllPages(fetch, 'sys_metadata', 'q', 'f', async () => 5);
    assert.equal(more.complete, false);
    assert.ok(more.warnings.some(w => /Pagination could not be verified/.test(w)));
    assert.ok(more.warnings.some(w => /3 matching records were not returned/.test(w)));

    for (const countRows of [undefined, async () => { throw new Error('403'); }, async () => undefined]) {
        const unknown = await readAllPages(fetch, 'sys_metadata', 'q', 'f', countRows as any);
        assert.equal(unknown.complete, false);
        assert.match(unknown.warnings[0], /Pagination could not be verified/);
    }
});

test('a read stops at the page cap instead of following pages forever', async () => {
    let calls = 0;
    const fetch: FetchPage = async () => { calls++; return { rows: Array.from({ length: 500 }, () => ({})) }; };
    const result = await readAllPages(fetch, 'sys_dictionary', 'q', 'f');
    assert.equal(calls, MAX_PAGES);
    assert.equal(result.complete, false);
    assert.match(result.warnings[0], new RegExp(`stopped after ${MAX_PAGES} pages`));
});

test('independently packaged hosts use identical discovery and paging logic', () => {
    const root = resolve(__dirname, '../..');
    assert.equal(readFileSync(resolve(root, 'src/ScopeDiscovery.ts'), 'utf8'), readFileSync(resolve(root, 'packages/snu/src/server/scopeDiscovery.ts'), 'utf8'));
});
