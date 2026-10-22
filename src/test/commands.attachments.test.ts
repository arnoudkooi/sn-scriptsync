import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createHarness } from './helpers/commandHarness';

const harness = createHarness();
// Install the vscode stub before loading the command module.
const { attachmentCommands } = require('../agent/commands/attachments');
const { backgroundCommands } = require('../agent/commands/background');
const download = attachmentCommands.find((c: any) => c.name === 'download_attachment');
const remove = attachmentCommands.find((c: any) => c.name === 'delete_attachment');
const runScript = backgroundCommands.find((c: any) => c.name === 'run_background_script');
const SYS_ID = '68cf699a97485f14c3e2fc90f053af5d';
const helper = { getHelperBuildInfo: () => ({ capabilities: { attachmentDownload: 1 } }) };

test.beforeEach(() => {
	harness.sent.length = 0;
	fs.writeFileSync(path.join(harness.instanceFolder, '_settings.json'),
		JSON.stringify({ name: 'testinst', url: 'https://testinst.service-now.com', g_ck: 'token' }));
});
test.after(() => harness.cleanup());

function helperReply(bytes: Buffer, extra: Record<string, any> = {}) {
	return {
		success: true, sysId: SYS_ID, fileName: 'lineup.png', contentType: 'image/png', tableName: 'sc_cat_item', tableSysId: 'a'.repeat(32),
		sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64'), ...extra,
	};
}

test('download: an old helper without the capability is refused before anything is sent', async () => {
	await assert.rejects(download.handle(harness.context(), { sys_id: SYS_ID }), { code: 'E_UNSUPPORTED_HELPER' });
	assert.equal(harness.sent.length, 0);
});

test('download: bytes go to a workspace file; the result carries path and metadata, not bytes', async () => {
	const bytes = crypto.randomBytes(4096);
	harness.reply(helperReply(bytes));
	const result = await download.handle(harness.context(helper), { sys_id: SYS_ID, maxBytes: 10_000 });
	assert.equal(harness.sent.length, 1);
	assert.equal(harness.sent[0].action, 'agentDownloadAttachment');
	assert.equal(harness.sent[0].sysId, SYS_ID);
	assert.equal(harness.sent[0].maxBytes, 10_000);
	assert.equal(result.filePath, path.join(harness.instanceFolder, 'attachments', SYS_ID, 'lineup.png'));
	assert.deepEqual(fs.readFileSync(result.filePath), bytes);
	assert.equal(JSON.stringify(result).includes(bytes.toString('base64')), false);
	assert.equal(result.relativePath, `attachments/${SYS_ID}/lineup.png`);
});

test('download: an existing target without overwrite is refused before the transfer', async () => {
	fs.writeFileSync(path.join(harness.instanceFolder, 'keep.bin'), 'mine');
	await assert.rejects(download.handle(harness.context(helper), { sys_id: SYS_ID, filePath: 'keep.bin' }), { code: 'E_FILE_EXISTS' });
	assert.equal(harness.sent.length, 0);
	assert.equal(fs.readFileSync(path.join(harness.instanceFolder, 'keep.bin'), 'utf8'), 'mine');
});

test('download: the helper\'s refusal keeps its code and writes nothing', async () => {
	harness.reply({ success: false, code: 'E_TOO_LARGE', error: 'larger than the limit' });
	await assert.rejects(download.handle(harness.context(helper), { sys_id: SYS_ID, filePath: 'big.bin' }), { code: 'E_TOO_LARGE' });
	assert.equal(fs.existsSync(path.join(harness.instanceFolder, 'big.bin')), false);
});

test('download: a dropped connection mid-transfer leaves no file reported as complete', async () => {
	harness.replyWithError(Object.assign(new Error('Browser helper disconnected'), { code: 'E_BROWSER_DISCONNECTED' }));
	await assert.rejects(download.handle(harness.context(helper), { sys_id: SYS_ID, filePath: 'cut.bin' }), { code: 'E_BROWSER_DISCONNECTED' });
	assert.deepEqual(fs.readdirSync(harness.instanceFolder).filter((n) => n.startsWith('cut') || n.includes('.partial')), []);
});

test('delete: dryRun only reads; a delete reads then uses the Attachment API', async () => {
	const meta = { success: true, status: 200, data: { result: { sys_id: SYS_ID, file_name: 'lineup.png', table_name: 'sc_cat_item', table_sys_id: 'a'.repeat(32), size_bytes: '1748088' } } };
	harness.reply(meta);
	const preview = await remove.handle(harness.context(), { sys_id: SYS_ID, dryRun: true });
	assert.deepEqual(preview, { dryRun: true, deleted: false, sys_id: SYS_ID, fileName: 'lineup.png', table: 'sc_cat_item', tableSysId: 'a'.repeat(32), sizeBytes: 1748088 });
	assert.deepEqual(harness.sent.map((m) => `${m.method} ${m.endpoint}`), [`GET /api/now/attachment/${SYS_ID}`]);

	harness.sent.length = 0;
	harness.reply(meta);
	harness.reply({ success: true, status: 204, data: '' });
	const deleted = await remove.handle(harness.context(), { sys_id: SYS_ID });
	assert.equal(deleted.deleted, true);
	assert.deepEqual(harness.sent.map((m) => `${m.method} ${m.endpoint}`), [`GET /api/now/attachment/${SYS_ID}`, `DELETE /api/now/attachment/${SYS_ID}`]);
});

test('delete: a missing attachment is E_NOT_FOUND and nothing is deleted', async () => {
	harness.reply({ success: false, status: 404, error: 'Record not found' });
	await assert.rejects(remove.handle(harness.context(), { sys_id: SYS_ID }), { code: 'E_NOT_FOUND' });
	assert.equal(harness.sent.filter((m) => m.method === 'DELETE').length, 0);
});

test('run_background_script: direct and reviewed runs return the same structured result', async () => {
	const output = "[0:00:00.1] Script completed<HR/>Script execution history <A HREF='sys_script_execution_history.do?sys_id=47eea1d697485f14c3e2fc90f053af06'>x</A><HR/><PRE>*** Script: done<BR/>[CacheFlushLog] flush<BR/></PRE>";
	harness.reply({ success: true, output });
	const direct = await runScript.handle(harness.context(), { script: 'gs.print("done")' });
	assert.deepEqual(direct, runScript.fromHelperResult({ success: true, output }, {}));
	assert.equal(direct.output, output);
	assert.equal(direct.stdout, 'done');
	assert.deepEqual(direct.logLines, ['[CacheFlushLog] flush']);
	assert.equal(direct.executionId, '47eea1d697485f14c3e2fc90f053af06');
	assert.equal(direct.status, 'completed');
});
