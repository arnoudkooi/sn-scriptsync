import test from 'node:test';
import assert from 'node:assert';
import { TOOLS, getToolByName, getToolByCliCommand } from '../registry.js';
import { formatHumanOutput } from '../cli/format.js';
import { resolveContextSecurity } from '../client.js';

test('Registry: exactly 18 tools registered', () => {
  assert.strictEqual(TOOLS.length, 18);
  const toolNames = TOOLS.map((t) => t.name);
  assert.deepStrictEqual(toolNames, [
    'snu_code_search',
    'snu_get_schema',
    'snu_get_context',
    'snu_query_records',
    'snu_pull_records',
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
    'snu_create_record',
    'snu_auth_status',
    'snu_rest_request',
  ]);
});

test('Adapter: snu_pull_records maps parameters correctly', () => {
  const tool = getToolByName('snu_pull_records')!;
  const mapped = tool.mapInput({
    table: 'sys_script_include',
    query: 'active=true^nameSTARTSWITHincident',
    'sys-id': '9659b9900a0a0b340079eb7c8a410eb8',
    fields: 'script,name,api_name',
    limit: '25',
    instance: 'dev123',
  });

  assert.strictEqual(mapped.command, 'pull_records');
  assert.strictEqual(mapped.instance, 'dev123');
  assert.strictEqual(mapped.params.table, 'sys_script_include');
  assert.strictEqual(mapped.params.query, 'active=true^nameSTARTSWITHincident');
  assert.strictEqual(mapped.params.sys_id, '9659b9900a0a0b340079eb7c8a410eb8');
  assert.deepStrictEqual(mapped.params.fields, ['script', 'name', 'api_name']);
  assert.strictEqual(mapped.params.limit, 25);
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

test('Context security: combines standalone host and selected-instance gates with deny-wins', () => {
  const security = resolveContextSecurity({
    gates: {
      backgroundScripts: false,
      deleteRecords: true,
      createArtifacts: true,
      browserDebugger: false,
      restRequest: true,
    },
    capabilities: { commandReview: 1, instanceSecurityGates: 1 },
    instanceGates: {
      'https://dev123.service-now.com': {
        gates: {
          backgroundScripts: 'approve',
          deleteRecords: 'approve',
          createArtifacts: 'auto',
          browserDebugger: 'off',
          restRequest: 'auto',
        },
      },
    },
  }, {
    defaultInstance: 'dev123',
    instances: [{ name: 'dev123', url: 'https://dev123.service-now.com/' }],
  });

  assert.strictEqual(security.instance?.origin, 'https://dev123.service-now.com');
  assert.strictEqual(security.effectiveGates.backgroundScripts.result, 'blocked_host');
  assert.strictEqual(security.effectiveGates.deleteRecords.result, 'approval_required');
  assert.strictEqual(security.effectiveGates.createArtifacts.result, 'allowed');
  assert.strictEqual(security.effectiveGates.browserDebugger.result, 'blocked_host');
});

test('Context security: missing instance snapshot fails closed', () => {
  const security = resolveContextSecurity({
    gates: { backgroundScripts: true },
    capabilities: { instanceSecurityGates: 1 },
    instanceGates: {},
  }, {
    defaultInstance: 'dev123',
    instances: [{ name: 'dev123', url: 'https://dev123.service-now.com' }],
  });

  assert.strictEqual(security.effectiveGates.backgroundScripts.instance, 'missing');
  assert.strictEqual(security.effectiveGates.backgroundScripts.result, 'blocked_instance');
});

test('Context security: resolves an explicitly named policy when an older daemon has no roster', () => {
  const security = resolveContextSecurity({
    gates: { createArtifacts: true },
    capabilities: { instanceSecurityGates: 1 },
    instanceGates: {
      'https://ven08329.service-now.com': {
        gates: { createArtifacts: 'auto' },
      },
      'https://dev324741.service-now.com': {
        gates: { createArtifacts: 'off' },
      },
    },
  }, { instances: [] }, 'ven08329');

  assert.strictEqual(security.instance?.origin, 'https://ven08329.service-now.com');
  assert.strictEqual(security.effectiveGates.createArtifacts.result, 'allowed');
  assert.deepStrictEqual(security.availableInstancePolicies.map((item) => item.name), ['ven08329', 'dev324741']);
});

test('Format: context labels host, instance, and effective policy separately', () => {
  const output = formatHumanOutput('get_context', {
    bridgeReady: true,
    serviceNowReady: true,
    browserConnected: true,
    security: {
      instance: { name: 'dev123', origin: 'https://dev123.service-now.com' },
      hostGates: { backgroundScripts: false },
      instanceGateProtocol: true,
      effectiveGates: {
        backgroundScripts: { host: false, instance: 'approve', result: 'blocked_host' },
        deleteRecords: { host: true, instance: 'approve', result: 'approval_required' },
        createArtifacts: { host: true, instance: 'auto', result: 'allowed' },
        browserDebugger: { host: false, instance: 'off', result: 'blocked_host' },
        restRequest: { host: true, instance: 'missing', result: 'blocked_instance' },
      },
    },
    instances: [],
  });

  assert.ok(output.includes('Security Policy for dev123 (https://dev123.service-now.com)'));
  assert.ok(output.includes('Host'));
  assert.ok(output.includes('Instance'));
  assert.ok(output.includes('Blocked by host'));
  assert.ok(output.includes('Approval required'));
  assert.ok(output.includes('Allowed'));
  assert.ok(!output.includes('Capabilities & Effective Permission Gates'));
});
