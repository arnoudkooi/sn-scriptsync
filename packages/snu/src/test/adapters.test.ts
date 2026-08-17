import test from 'node:test';
import assert from 'node:assert';
import { TOOLS, getToolByName, getToolByCliCommand } from '../registry.js';
import { formatHumanOutput } from '../cli/format.js';

test('Registry: exactly 14 tools registered', () => {
  assert.strictEqual(TOOLS.length, 14);
  const toolNames = TOOLS.map((t) => t.name);
  assert.deepStrictEqual(toolNames, [
    'snu_code_search',
    'snu_get_schema',
    'snu_get_context',
    'snu_query_records',
    'snu_get_record',
    'snu_create_artifact',
    'snu_update_record',
    'snu_delete_record',
    'snu_run_background_script',
    'snu_get_form_state',
    'snu_set_form_field',
    'snu_run_ui_action',
    'snu_navigate',
    'snu_take_screenshot',
  ]);
});

test('Adapter: snu_code_search maps parameters correctly', () => {
  const tool = getToolByName('snu_code_search')!;
  const mapped = tool.mapInput({
    term: 'GlideRecord',
    tables: 'sys_script_include,sys_ui_action',
    limit: 25,
    activeOnly: true,
    instance: 'dev123',
  });

  assert.strictEqual(mapped.command, 'code_search');
  assert.strictEqual(mapped.instance, 'dev123');
  assert.strictEqual(mapped.params.term, 'GlideRecord');
  assert.strictEqual(mapped.params.tables, 'sys_script_include,sys_ui_action');
  assert.strictEqual(mapped.params.limit, 25);
  assert.strictEqual(mapped.params.activeOnly, true);
});

test('Adapter: snu_query_records handles ORDERBY formatting and defaults', () => {
  const tool = getToolByName('snu_query_records')!;

  // Default fields and limit
  const m1 = tool.mapInput({ table: 'incident' });
  assert.strictEqual(m1.command, 'query_records');
  assert.strictEqual(m1.params.table, 'incident');
  assert.strictEqual(m1.params.fields, 'sys_id,number,short_description,sys_created_on');
  assert.strictEqual(m1.params.limit, 10);
  assert.strictEqual(m1.params.orderBy, undefined);

  // Prefixes ORDERBY when missing
  const m2 = tool.mapInput({ table: 'incident', orderBy: 'sys_created_on' });
  assert.strictEqual(m2.params.orderBy, 'ORDERBYsys_created_on');

  // Preserves existing ORDERBY prefix
  const m3 = tool.mapInput({ table: 'incident', orderBy: 'ORDERBYDESCsys_created_on' });
  assert.strictEqual(m3.params.orderBy, 'ORDERBYDESCsys_created_on');
});

test('Adapter: snu_create_artifact injects fields.name and await: true', () => {
  const tool = getToolByName('snu_create_artifact')!;
  const mapped = tool.mapInput({
    table: 'sys_script_include',
    name: 'MyUtil',
    fields: { script: 'var MyUtil = Class.create();' },
    scope: 'x_acme_app',
    instance: 'dev123',
  });

  assert.strictEqual(mapped.command, 'create_artifact');
  assert.strictEqual(mapped.instance, 'dev123');
  assert.strictEqual(mapped.params.table, 'sys_script_include');
  assert.strictEqual(mapped.params.fields.name, 'MyUtil');
  assert.strictEqual(mapped.params.fields.script, 'var MyUtil = Class.create();');
  assert.strictEqual(mapped.params.scope, 'x_acme_app');
  assert.strictEqual(mapped.params.await, true);
});

test('Adapter: snu_update_record maps value -> content with await: true', () => {
  const tool = getToolByName('snu_update_record')!;
  const mapped = tool.mapInput({
    table: 'sys_script_include',
    sys_id: '12345678901234567890123456789012',
    field: 'script',
    value: 'var Updated = 1;',
    instance: 'dev123',
  });

  assert.strictEqual(mapped.command, 'update_record');
  assert.strictEqual(mapped.instance, 'dev123');
  assert.strictEqual(mapped.params.table, 'sys_script_include');
  assert.strictEqual(mapped.params.sys_id, '12345678901234567890123456789012');
  assert.strictEqual(mapped.params.field, 'script');
  assert.strictEqual(mapped.params.content, 'var Updated = 1;');
  assert.strictEqual(mapped.params.await, true);
});

test('Adapter: snu_delete_record enforces confirm or dryRun', () => {
  const tool = getToolByName('snu_delete_record')!;

  // Missing confirm throws
  assert.throws(
    () => tool.mapInput({ table: 'incident', sys_id: '123' }),
    /snu_delete_record is destructive: pass --confirm to execute or --dry-run/
  );

  // Dry run succeeds without confirm
  const dryRun = tool.mapInput({ table: 'incident', sys_id: '123', dryRun: true });
  assert.strictEqual(dryRun.command, 'delete_record');
  assert.strictEqual(dryRun.params.dryRun, true);

  // Confirm succeeds
  const confirmed = tool.mapInput({ table: 'incident', sys_id: '123', confirm: true });
  assert.strictEqual(confirmed.command, 'delete_record');
  assert.strictEqual(confirmed.params.dryRun, false);
});

test('Format: Staged write formatting in CLI', () => {
  const output = formatHumanOutput('update_record', {
    staged: true,
    reviewId: 'review_99',
    message: 'Write staged for review.',
  });

  assert.ok(output.includes('[Staged]'));
  assert.ok(output.includes('review_99'));
  assert.ok(output.includes('Pending Saves'));
});
