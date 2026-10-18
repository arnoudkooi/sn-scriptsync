// Run after building both packages: node --test scripts/test-bridge-parity.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const { createHarness } = require('../out/test/helpers/commandHarness.js');
const harness = createHarness(); // Installs the VS Code stub before loading handlers.
const { recordsCommands } = require('../out/agent/commands/records.js');
const { browserCommands } = require('../out/agent/commands/browser.js');
const { searchCommands } = require('../out/agent/commands/search.js');
const { bulkCommands } = require('../out/agent/commands/bulk.js');
const editorPolicy = require('../out/agent/policy.js');
const standalonePolicy = require('../packages/snu/dist/server/policy.js');
const { StandaloneDispatcher } = require('../packages/snu/dist/server/dispatcher.js');
const { StandaloneWsBridge } = require('../packages/snu/dist/server/wsBridge.js');
const { PendingRegistry } = require('../packages/snu/dist/server/pendingRegistry.js');
const sysId = '0123456789abcdef0123456789abcdef';
const handlers = [...recordsCommands, ...browserCommands, ...searchCommands, ...bulkCommands];

test('shared hosts produce compatible helper requests, results and policies', async t => {
  t.after(() => harness.cleanup());
  const pending = new PendingRegistry();
  t.after(() => pending.rejectAll('E_CANCELLED', 'Test finished'));
  const bridge = new StandaloneWsBridge(0, pending);
  bridge.hasBrowserClient = () => true;
  bridge.getLiveInstances = () => [{ name: 'testinst', url: 'https://testinst.service-now.com', g_ck: 'test-token', lastActiveAt: Date.now() }];
  bridge.getHelperState = () => ({ tier: 'pro', proFeatures: true,
    cdp: { available: false }, capabilities: { instanceSecurityGates: 1, commandReview: 1, recordBatch: 1 } });
  bridge.getInstanceGate = () => 'auto';
  const sent = [];
  let reply;
  bridge.sendToBrowser = message => {
    sent.push(message);
    pending.resolve(message.agentRequestId, reply);
  };
  const dispatcher = new StandaloneDispatcher({ cwd: harness.workspaceRoot, wsBridge: bridge, pending,
    cliFlags: { updateRecords: true, createArtifacts: true } });
  // Correlation, session and host labels differ; the helper's operation must not.
  const operation = ({ agentRequestId, instance, appName, ...message }) => JSON.parse(JSON.stringify(message));
  const compare = async (command, params, response) => {
    reply = response;
    harness.reply(response);
    const editorResult = await handlers.find(handler => handler.name === command).handle(harness.context(), params);
    const standalone = await dispatcher.dispatch({ id: command, command, params, instance: 'testinst' });
    assert.equal(standalone.status, 'success', standalone.error);
    assert.deepEqual(operation(sent.at(-1)), operation(harness.sent.at(-1)));
    assert.deepEqual(standalone.result, editorResult);
  };
  await t.test('multiple fields on one record use the same awaited PATCH', () => compare('update_record_batch',
    { table: 'sp_widget', sys_id: sysId, fields: { script: 'a\nb\n', css: 'a{}', sys_scope: 'global' }, await: true },
    { success: true, status: 200, data: { result: { script: 'a\nb\n', css: 'a{}' } } }));
  await t.test('binary attachment bytes, target and MIME type agree', async () => {
    fs.writeFileSync(path.join(harness.instanceFolder, 'report.pdf'), Buffer.from([0, 255, 1, 128]));
    await compare('upload_attachment', { table: 'incident', sys_id: sysId, filePath: 'report.pdf' },
      { success: true, attachment: { sys_id: 'attachment-id', file_name: 'report.pdf' } });
  });
  await t.test('#164 code search uses searchTerm and nested options on both hosts', () => compare('code_search',
    { term: 'GlideRecord', activeOnly: true, tables: 'sys_script_include, sys_script', limit: 20 },
    { success: true, searchTerm: 'GlideRecord', stats: { count: 1 }, words: [], results: [{ sys_id: sysId }] }));
  await t.test('shared commands use the same permission policies', () => {
    for (const command of ['negotiate', 'get_review_result', 'create_artifact', 'update_record_batch', 'upload_attachment', 'code_search']) {
      assert.deepEqual(standalonePolicy.getCommandPolicy({ command }), editorPolicy.getCommandPolicy({ command }));
    }
  });
  await t.test('editor negotiation returns the version of the actual extension ID', async () => {
    const metadata = require('../package.json');
    require('vscode').extensions = { getExtension: id => {
      assert.equal(id, `${metadata.publisher}.${metadata.name}`);
      return { packageJSON: metadata };
    } };
    require('../out/agent/runtime.js').setRuntime(harness.context());
    require('../out/agent/commands/index.js'); // Load the registry before its circular negotiation handler.
    const { negotiateCommands } = require('../out/agent/commands/negotiate.js');
    const result = await negotiateCommands[0].handle(harness.context(), {});
    assert.equal(result.extensionVersion, metadata.version);
    assert.ok(result.commands.includes('update_record_batch'));
    assert.ok(result.commands.includes('upload_attachment'));
  });
  await t.test('record batches send the helper the same rows and map its ledger the same way', async () => {
    // The batch id is random per call; everything else must agree.
    const withoutId = ({ agentRequestId, instance, appName, batchId, ...message }) => JSON.parse(JSON.stringify(message));
    const resultWithoutId = ({ batchId, ...rest }) => rest;
    const editorContext = harness.context({ getHelperBuildInfo: () => ({ capabilities: { recordBatch: 1 } }) });
    for (const [command, params] of [
      ['update_records', { table: 'incident', continueOnError: true, rows: [{ sys_id: sysId.toUpperCase(), urgency: '2' }] }],
      ['create_records', { table: 'sys_choice', deadlineMinutes: 2, rows: [{ label: 'a', sys_scope: 'global' }, { label: 'b' }] }],
    ]) {
      const mode = command === 'create_records' ? 'create' : 'update';
      const answer = message => ({ success: true, batch: { batchId: message.batchId, mode, table: params.table, total: params.rows.length, running: false,
        rows: params.rows.map((_, index) => ({ index, outcome: 'succeeded', status: 201 })) } });
      // The helper echoes the batch id it was sent, on both hosts.
      reply = undefined;
      const sendStandalone = bridge.sendToBrowser;
      bridge.sendToBrowser = message => { sent.push(message); pending.resolve(message.agentRequestId, answer(message)); };
      const standalone = await dispatcher.dispatch({ id: command, command, params, instance: 'testinst' });
      bridge.sendToBrowser = sendStandalone;
      assert.equal(standalone.status, 'success', standalone.error);
      const editorPromise = handlers.find(handler => handler.name === command).handle({ ...editorContext,
        waitForBrowserResponse: async () => answer(harness.sent.at(-1)) }, params);
      const editorResult = await editorPromise;
      assert.equal(sent.at(-1).action, 'agentRecordBatch');
      assert.deepEqual(withoutId(sent.at(-1)), withoutId(harness.sent.at(-1)));
      assert.deepEqual(resultWithoutId(standalone.result), resultWithoutId(editorResult));
    }
    for (const command of ['create_records', 'update_records', 'get_batch_result']) {
      for (const params of [{}, { dryRun: true }]) {
        assert.deepEqual(standalonePolicy.getCommandPolicy({ command, params }), editorPolicy.getCommandPolicy({ command, params }));
      }
    }
    assert.equal(fs.readFileSync(path.join(root, 'src/agent/bulkWrite.ts'), 'utf8'),
      fs.readFileSync(path.join(root, 'packages/snu/src/server/bulkWrite.ts'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(root, 'src/agent/bulkWriteVectors.ts'), 'utf8'),
      fs.readFileSync(path.join(root, 'packages/snu/src/server/bulkWriteVectors.ts'), 'utf8'));
  });
  await t.test('file input validation cannot drift between hosts', () => {
    assert.equal(fs.readFileSync(path.join(root, 'src/agent/attachmentInput.ts'), 'utf8'),
      fs.readFileSync(path.join(root, 'packages/snu/src/server/attachmentInput.ts'), 'utf8'));
  });
});
