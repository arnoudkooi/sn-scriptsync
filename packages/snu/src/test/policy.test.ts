import test from 'node:test';
import assert from 'node:assert';
import { batchSubRequests, getCommandPolicy, resolveGateMode } from '../server/policy.js';

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

test('Policy: sdk_deploy is gated but confirmed in the helper modal, not a command review', () => {
  const policy = getCommandPolicy({ id: '1', command: 'sdk_deploy', params: {} });
  assert.deepStrictEqual(policy.gates, ['createArtifacts']);
  assert.strictEqual(policy.selfConfirmed, true);
  assert.strictEqual(getCommandPolicy({ id: '2', command: 'create_record', params: {} }).selfConfirmed, undefined);
});

// A Batch API call (POST /api/now/v1/batch) carries requests with their own
// methods. The policy saw one POST, so the DELETEs inside it met neither the
// deleteRecords gate nor the Review Queue.
test('Policy: a Batch API call is classified by its sub-requests', () => {
  const batch = (body: any, extra: Record<string, any> = {}) =>
    getCommandPolicy({ id: '1', command: 'rest_request', params: { endpoint: '/api/now/v1/batch', method: 'POST', body, ...extra } });
  const reviewedDelete = { risk: 'delete', gates: ['deleteRecords', 'restRequest'], review: 'required', reviewKind: 'rest_batch' };
  const plainWrite = { risk: 'write', gates: ['restRequest'], review: 'never' };

  // One DELETE among reads makes the batch a reviewed delete, whatever its case.
  assert.deepStrictEqual(batch({ batch_request_id: 'b', rest_requests: [
    { id: '1', method: 'GET', url: '/api/now/table/incident' },
    { id: '2', method: 'DELETE', url: '/api/now/table/incident/abc' },
  ] }), reviewedDelete);
  assert.deepStrictEqual(batch({ rest_requests: [{ method: 'delete', url: '/api/now/table/incident/abc' }] }), reviewedDelete);

  // Writes stay the write the outer POST already was.
  assert.deepStrictEqual(batch({ rest_requests: [
    { method: 'PATCH', url: '/x' }, { method: 'POST', url: '/y' }, { method: 'GET', url: '/z' },
  ] }), plainWrite);
  assert.deepStrictEqual(batch({ rest_requests: [] }), plainWrite);

  // A body given as JSON text is read the same way.
  assert.deepStrictEqual(batch(JSON.stringify({ rest_requests: [{ method: 'DELETE', url: '/x' }] })), reviewedDelete);
  assert.deepStrictEqual(batch(JSON.stringify({ rest_requests: [{ method: 'PUT', url: '/x' }] })), plainWrite);

  // A batch whose requests cannot be read is reviewed as a delete, never waved through.
  for (const body of [undefined, null, {}, { rest_requests: 'x' }, '{not json', { rest_requests: [{ url: '/x' }] }, { rest_requests: [{ method: 'TRACE', url: '/x' }] }]) {
    assert.deepStrictEqual(batch(body), reviewedDelete, `body ${JSON.stringify(body)}`);
  }

  // Every spelling of the endpoint is the Batch API.
  for (const endpoint of ['/api/now/v1/batch/', '/api/now/v1/batch?sysparm_x=1', '/API/NOW/V1/BATCH', '/api/now/v2/batch', '/api//now//v1/batch', '/api/now/v1/./batch', '/api/now/v1/x/../batch', '/api/now/v1/%2e/batch', '/api/now/v1/x/%2e%2e/batch', '/api/now/v1/batch#ignored']) {
    assert.deepStrictEqual(batch({ rest_requests: [{ method: 'DELETE', url: '/x' }] }, { endpoint }), reviewedDelete, endpoint);
  }

  // Anywhere else, a POST is a POST, whatever the body looks like.
  assert.deepStrictEqual(batch({ rest_requests: [{ method: 'DELETE', url: '/x' }] }, { endpoint: '/api/now/table/incident' }), plainWrite);
  assert.deepStrictEqual(batch({ rest_requests: [{ method: 'DELETE', url: '/x' }] }, { endpoint: '/api/now/v1/batch/extra' }), plainWrite);
  // The helper sends no body with a GET, so a GET to the endpoint carries nothing.
  assert.deepStrictEqual(batch({ rest_requests: [{ method: 'DELETE', url: '/x' }] }, { method: 'GET' }), { risk: 'read', gates: [], review: 'never' });
  // An outer DELETE is the stricter case already.
  assert.strictEqual(batch({ rest_requests: [] }, { method: 'DELETE' }).reviewKind, 'rest_delete');

  assert.strictEqual(batchSubRequests({ endpoint: '/api/now/table/incident', body: { rest_requests: [] } }), undefined);
  assert.strictEqual(batchSubRequests({ endpoint: '/api/now/v1/batch', body: {} }), null);
  assert.deepStrictEqual(batchSubRequests({ endpoint: '/api/now/v1/batch', body: { rest_requests: [{ method: 'patch', url: '/x', body: 'e30=' }] } }),
    [{ method: 'PATCH', url: '/x' }]);
});

// Regression: dry runs used to reach the helper's deletion executor via review.
test('Policy: a delete_record dry run is a preflight, not a review', () => {
  for (const params of [{ table: 'incident', sys_id: '123', dryRun: true }, { table: 'incident', query: 'active=false', dryRun: true }]) {
    const policy = getCommandPolicy({ id: '1', command: 'delete_record', params });
    assert.deepStrictEqual(policy, { risk: 'delete', gates: ['deleteRecords'], review: 'never', preflight: true });
  }
  const bulk = getCommandPolicy({ id: '2', command: 'delete_record', params: { table: 'incident', query: 'active=false', limit: 5, confirm: true } });
  assert.deepStrictEqual(bulk, { risk: 'delete', gates: ['deleteRecords'], review: 'required', reviewKind: 'record_delete' });
  assert.strictEqual(getCommandPolicy({ id: '3', command: 'delete_record', params: { table: 'incident', sys_id: '123', dryRun: 'yes' } }).review, 'required');
});
