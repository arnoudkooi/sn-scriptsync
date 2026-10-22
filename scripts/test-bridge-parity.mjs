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
const { profileCommands } = require('../out/agent/commands/profile.js');
const { attachmentCommands } = require('../out/agent/commands/attachments.js');
const { backgroundCommands } = require('../out/agent/commands/background.js');
const { queryCommands } = require('../out/agent/commands/query.js');
const { VECTOR_SCHEMA } = require('../out/agent/queryValidationVectors.js');
const crypto = require('node:crypto');
const editorPolicy = require('../out/agent/policy.js');
const standalonePolicy = require('../packages/snu/dist/server/policy.js');
const { StandaloneDispatcher } = require('../packages/snu/dist/server/dispatcher.js');
const { StandaloneWsBridge } = require('../packages/snu/dist/server/wsBridge.js');
const { PendingRegistry } = require('../packages/snu/dist/server/pendingRegistry.js');
const sysId = '0123456789abcdef0123456789abcdef';
const handlers = [...recordsCommands, ...browserCommands, ...searchCommands, ...bulkCommands, ...profileCommands, ...attachmentCommands, ...backgroundCommands, ...queryCommands];

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
    cliFlags: { updateRecords: true, createArtifacts: true, backgroundScripts: true, deleteRecords: true } });
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
  await t.test('artifact type profiles: same reads in the same order, same profile, read-only on both hosts', async () => {
    // A deterministic fake instance answer per read: one catalog item with one variable.
    const answer = message => {
      const q = message.queryParams || {};
      if (message.method !== 'GET') return { success: false, error: 'write attempted' };
      if (message.endpoint.startsWith('/api/now/stats/')) return { success: true, status: 200, data: { result: { stats: { count: message.endpoint.endsWith('item_option_new') ? '1' : '0' } } } };
      if (message.endpoint === '/api/now/table/sc_cat_item' && /sys_idIN/.test(q.sysparm_query)) {
        return { success: true, status: 200, data: { result: [{ sys_id: sysId, name: 'Item', sys_updated_on: '2026-10-18 10:00:00', active: 'true' }] } };
      }
      return { success: true, status: 200, data: { result: [] } };
    };
    const params = { type: 'catalog_item', roots: [sysId], detail: true, save: false, refresh: true };
    const editorReads = [];
    const editorContext = harness.context({
      sendToBrowser: m => { editorReads.push(m); },
      waitForBrowserResponse: () => new Promise(resolve => setImmediate(() => resolve(answer(editorReads.at(-1))))),
    });
    const editor = await profileCommands[0].handle(editorContext, params);
    const standaloneReads = [];
    const sendStandalone = bridge.sendToBrowser;
    bridge.sendToBrowser = message => { standaloneReads.push(message); pending.resolve(message.agentRequestId, answer(message)); };
    const standalone = await dispatcher.dispatch({ id: 'profile', command: 'analyze_artifact_type', params, instance: 'testinst' });
    bridge.sendToBrowser = sendStandalone;
    assert.equal(standalone.status, 'success', standalone.error);
    const reads = list => list.map(m => `${m.method} ${m.endpoint} ${JSON.stringify(m.queryParams || {})}`);
    assert.deepEqual(reads(standaloneReads), reads(editorReads));
    assert.ok(editorReads.length > 10 && editorReads.every(m => m.method === 'GET'), 'only GETs');
    const comparable = ({ generatedAt, savedTo, ...rest }) => rest;
    assert.deepEqual(comparable(standalone.result), comparable(editor));
    for (const params of [{}, { type: 'table' }]) {
      assert.deepEqual(standalonePolicy.getCommandPolicy({ command: 'analyze_artifact_type', params }), editorPolicy.getCommandPolicy({ command: 'analyze_artifact_type', params }));
    }
    assert.equal(fs.readFileSync(path.join(root, 'src/agent/artifactProfile.ts'), 'utf8'),
      fs.readFileSync(path.join(root, 'packages/snu/src/server/artifactProfile.ts'), 'utf8'));
  });
  await t.test('file input validation cannot drift between hosts', () => {
    assert.equal(fs.readFileSync(path.join(root, 'src/agent/attachmentInput.ts'), 'utf8'),
      fs.readFileSync(path.join(root, 'packages/snu/src/server/attachmentInput.ts'), 'utf8'));
  });
  await t.test('file output, script results and their vectors cannot drift between hosts', () => {
    for (const file of ['attachmentOutput.ts', 'backgroundScript.ts', 'backgroundScriptVectors.ts', 'queryValidation.ts', 'queryValidationVectors.ts']) {
      assert.equal(fs.readFileSync(path.join(root, 'src/agent', file), 'utf8'),
        fs.readFileSync(path.join(root, 'packages/snu/src/server', file), 'utf8'), file);
    }
  });
  await t.test('background scripts: same helper request and the same structured result', () => compare('run_background_script',
    { script: 'gs.print("hi")' },
    { success: true, output: "Script execution history <A HREF='sys_script_execution_history.do?sys_id=47eea1d697485f14c3e2fc90f053af06'>x</A><PRE>*** Script: hi<BR/>[CacheFlushLog] x<BR/></PRE>" }));
  await t.test('attachment download: same helper request, same file, same result', async () => {
    const bytes = crypto.randomBytes(2048);
    const downloadReply = { success: true, sysId, fileName: 'lineup.png', contentType: 'image/png', tableName: 'sc_cat_item', tableSysId: sysId,
      sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') };
    const getHelperState = bridge.getHelperState;
    bridge.getHelperState = () => ({ ...getHelperState(), capabilities: { ...getHelperState().capabilities, attachmentDownload: 1 } });
    const params = { sys_id: sysId, overwrite: true };
    reply = downloadReply;
    const standalone = await dispatcher.dispatch({ id: 'download_attachment', command: 'download_attachment', params, instance: 'testinst' });
    bridge.getHelperState = getHelperState;
    assert.equal(standalone.status, 'success', standalone.error);
    harness.reply(downloadReply);
    const editor = await handlers.find(handler => handler.name === 'download_attachment')
      .handle(harness.context({ getHelperBuildInfo: () => ({ capabilities: { attachmentDownload: 1 } }) }), params);
    assert.deepEqual(operation(sent.at(-1)), operation(harness.sent.at(-1)));
    assert.deepEqual(standalone.result, editor);
    assert.deepEqual(fs.readFileSync(editor.filePath), bytes);
  });
  await t.test('attachment delete: same reads and delete, same result', async () => {
    const meta = { success: true, status: 200, data: { result: { sys_id: sysId, file_name: 'a.png', table_name: 'incident', table_sys_id: sysId, size_bytes: '10' } } };
    for (const params of [{ sys_id: sysId, dryRun: true }, { sys_id: sysId }]) {
      const before = sent.length;
      reply = meta;
      const standalone = await dispatcher.dispatch({ id: 'delete_attachment', command: 'delete_attachment', params, instance: 'testinst' });
      assert.equal(standalone.status, 'success', standalone.error);
      const editorBefore = harness.sent.length;
      harness.reply(meta);
      if (!params.dryRun) harness.reply(meta);
      const editor = await handlers.find(handler => handler.name === 'delete_attachment').handle(harness.context(), params);
      assert.deepEqual(sent.slice(before).map(operation), harness.sent.slice(editorBefore).map(operation));
      assert.deepEqual(standalone.result, editor);
    }
  });
  await t.test('query validation: same schema reads, same result or the same error on both hosts', async () => {
    const answerMeta = (endpoint) => {
      const table = endpoint.split('/').pop();
      const columns = VECTOR_SCHEMA[table];
      return columns === null ? { success: false, status: 403, error: 'ACL' } : { success: true, status: 200, data: { result: { columns: columns || {} } } };
    };
    const run = async (params) => {
      const standaloneReads = [];
      const sendStandalone = bridge.sendToBrowser;
      bridge.sendToBrowser = message => {
        standaloneReads.push(message.endpoint);
        pending.resolve(message.agentRequestId, message.endpoint.startsWith('/api/now/ui/meta/')
          ? answerMeta(message.endpoint) : { success: true, status: 200, data: { result: [{ sys_id: sysId }] } });
      };
      const standalone = await dispatcher.dispatch({ id: 'query_records', command: 'query_records', params, instance: 'testinst' });
      bridge.sendToBrowser = sendStandalone;
      const editorReads = [];
      const editorContext = harness.context({
        sendToBrowser: m => { editorReads.push(m.endpoint || m.action); },
        waitForBrowserResponse: () => new Promise(resolve => setImmediate(() => {
          const last = editorReads.at(-1);
          resolve(last === 'agentQueryRecords' ? { success: true, tableName: params.table, count: 1, records: [{ sys_id: sysId }] } : answerMeta(last));
        })),
      });
      let editor, editorError;
      try { editor = await queryCommands.find(c => c.name === 'query_records').handle(editorContext, params); } catch (error) { editorError = error; }
      const meta = list => list.filter(e => String(e).startsWith('/api/now/ui/meta/'));
      assert.deepEqual(meta(standaloneReads), meta(editorReads));
      return { standalone, editor, editorError };
    };
    const ok = await run({ table: 'question_choice', query: 'question.ref_item_option_new.cat_item=y^ORDERBYorder', fields: 'text,question.question_text' });
    assert.equal(ok.standalone.status, 'success', ok.standalone.error);
    assert.deepEqual(ok.standalone.result, ok.editor);
    const bad = await run({ table: 'question_choice', query: 'question.cat_item=x', fields: 'text' });
    assert.equal(bad.standalone.code, 'E_INVALID_QUERY');
    assert.equal(bad.editorError.code, 'E_INVALID_QUERY');
    assert.equal(bad.standalone.error, bad.editorError.message);
    assert.deepEqual(bad.standalone.details, bad.editorError.details);
  });
  await t.test('attachment and script commands use the same permission policies', () => {
    for (const request of [
      { command: 'download_attachment' }, { command: 'delete_attachment' }, { command: 'delete_attachment', params: { dryRun: true } },
      { command: 'run_background_script' },
    ]) {
      assert.deepEqual(standalonePolicy.getCommandPolicy(request), editorPolicy.getCommandPolicy(request));
    }
  });
});
