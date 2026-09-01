import test from 'node:test';
import assert from 'node:assert';
import { getCommandPolicy, resolveGateMode } from '../server/policy.js';

test('Policy: maps command risks, required gates, and review requirements', () => {
  // 1. Background script -> execute, backgroundScripts gate, required review
  const bgPolicy = getCommandPolicy({ id: '1', command: 'run_background_script', params: { script: 'test' } });
  assert.strictEqual(bgPolicy.risk, 'execute');
  assert.deepStrictEqual(bgPolicy.gates, ['backgroundScripts']);
  assert.strictEqual(bgPolicy.review, 'required');
  assert.strictEqual(bgPolicy.reviewKind, 'background_script');

  // 2. Delete record -> delete, deleteRecords gate, required review
  const delPolicy = getCommandPolicy({ id: '2', command: 'delete_record', params: { table: 'incident', sys_id: '123' } });
  assert.strictEqual(delPolicy.risk, 'delete');
  assert.deepStrictEqual(delPolicy.gates, ['deleteRecords']);
  assert.strictEqual(delPolicy.review, 'required');
  assert.strictEqual(delPolicy.reviewKind, 'record_delete');

  // 3. REST DELETE -> delete, deleteRecords gate, required review
  const restDelPolicy = getCommandPolicy({ id: '3', command: 'rest_request', params: { method: 'DELETE' } });
  assert.strictEqual(restDelPolicy.risk, 'delete');
  assert.deepStrictEqual(restDelPolicy.gates, ['deleteRecords']);
  assert.strictEqual(restDelPolicy.review, 'required');
  assert.strictEqual(restDelPolicy.reviewKind, 'rest_delete');

  // 4. REST GET -> read, no gates, review never
  const restGetPolicy = getCommandPolicy({ id: '4', command: 'rest_request', params: { method: 'GET' } });
  assert.strictEqual(restGetPolicy.risk, 'read');
  assert.deepStrictEqual(restGetPolicy.gates, []);
  assert.strictEqual(restGetPolicy.review, 'never');

  // 5. Normal UI action -> execute, review never
  const savePolicy = getCommandPolicy({ id: '5', command: 'run_ui_action', params: { uiAction: 'sysverb_update' } });
  assert.strictEqual(savePolicy.risk, 'execute');
  assert.strictEqual(savePolicy.review, 'never');

  // 6. Destructive UI action -> delete, deleteRecords gate, required review
  const destroyPolicy = getCommandPolicy({ id: '6', command: 'run_ui_action', params: { uiAction: 'sysverb_delete' } });
  assert.strictEqual(destroyPolicy.risk, 'delete');
  assert.deepStrictEqual(destroyPolicy.gates, ['deleteRecords']);
  assert.strictEqual(destroyPolicy.review, 'required');
});

// Issue #158: update_record carried an empty gate list and update_record_batch
// was missing from the switch entirely, so it was classified as a read.
test('Policy: updates to existing records are gated writes', () => {
  for (const command of ['update_record', 'update_record_batch']) {
    const policy = getCommandPolicy({ id: '1', command, params: { table: 'incident', sys_id: '123' } });
    assert.strictEqual(policy.risk, 'write', `${command} is a write`);
    assert.deepStrictEqual(policy.gates, ['updateRecords'], `${command} is gated`);
  }
});

test('Policy: a gate a publisher does not know about resolves through its fallback', () => {
  // Older host/helper builds publish the five original gates only.
  const legacy = { backgroundScripts: 'off', deleteRecords: 'off', createArtifacts: 'approve', browserDebugger: 'off', restRequest: 'off' };
  assert.strictEqual(resolveGateMode(legacy, 'updateRecords'), 'approve');

  // An explicit value always wins over the fallback, in both directions.
  assert.strictEqual(resolveGateMode({ ...legacy, updateRecords: 'off' }, 'updateRecords'), 'off');
  assert.strictEqual(resolveGateMode({ ...legacy, createArtifacts: 'off', updateRecords: 'auto' }, 'updateRecords'), 'auto');

  // Gates without a fallback keep reading as absent.
  assert.strictEqual(resolveGateMode({}, 'deleteRecords'), undefined);
  assert.strictEqual(resolveGateMode(null, 'updateRecords'), undefined);
});

test('Policy: attachment uploads and form commits are gated writes', () => {
  // An upload inserts sys_attachment, so it rides the create permission.
  const upload = getCommandPolicy({ id: '1', command: 'upload_attachment', params: { table: 'incident', sys_id: '123' } });
  assert.strictEqual(upload.risk, 'write');
  assert.deepStrictEqual(upload.gates, ['createArtifacts']);

  // Committing the open form writes an existing record, whatever the verb is
  // called: a custom action's name says nothing about what it does.
  for (const uiAction of ['sysverb_update', 'save', 'x_acme_do_the_thing']) {
    const policy = getCommandPolicy({ id: '2', command: 'run_ui_action', params: { uiAction } });
    assert.deepStrictEqual(policy.gates, ['updateRecords'], `${uiAction} is gated`);
    assert.strictEqual(policy.review, 'never');
  }

  // The delete escalation still wins, so updateRecords is not a route to it.
  const destructive = getCommandPolicy({ id: '3', command: 'run_ui_action', params: { uiAction: 'sysverb_delete' } });
  assert.deepStrictEqual(destructive.gates, ['deleteRecords']);
  assert.strictEqual(destructive.review, 'required');
});
