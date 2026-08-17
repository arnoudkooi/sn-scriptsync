import test from 'node:test';
import assert from 'node:assert';
import { getCommandPolicy } from '../server/policy.js';

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
