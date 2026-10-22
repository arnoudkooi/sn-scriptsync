import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_MAX_ATTACHMENT_BYTES, checkDownloadTarget, decodeAttachmentReply, publishFile, resolveDownloadTarget,
  safeAttachmentFileName, saveDownloadedAttachment, validateDownloadParams,
} from '../server/attachmentOutput.js';

const SYS_ID = '68cf699a97485f14c3e2fc90f053af5d';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-attach-out-'));
  const base = path.join(root, 'dev1');
  fs.mkdirSync(base);
  return { root, base, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function reply(bytes: Buffer, extra: Record<string, any> = {}) {
  return {
    success: true, fileName: 'lineup.png', contentType: 'image/png', tableName: 'sc_cat_item', tableSysId: 'a'.repeat(32),
    sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64'),
    ...extra,
  };
}

function tempFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.partial')) : [];
}

/**
 * Replace linkSync on the real fs module for the duration of body. The module
 * under test reads fs.linkSync at call time through its import wrapper.
 */
function withLink(replacement: (original: typeof fs.linkSync) => typeof fs.linkSync, body: () => void) {
  const realFs = require('fs');
  const original = realFs.linkSync;
  realFs.linkSync = replacement(original);
  try { body(); } finally { realFs.linkSync = original; }
}

test('download params: sys_id required, overwrite boolean, maxBytes bounded', () => {
  assert.throws(() => validateDownloadParams({}), { code: 'E_INVALID_PARAMS' });
  assert.throws(() => validateDownloadParams({ sys_id: SYS_ID, overwrite: 'yes' }), { code: 'E_INVALID_PARAMS' });
  assert.throws(() => validateDownloadParams({ sys_id: SYS_ID, maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES + 1 }), { code: 'E_INVALID_PARAMS' });
  assert.deepEqual(validateDownloadParams({ sys_id: SYS_ID.toUpperCase() }), { sysId: SYS_ID, overwrite: false, maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES });
});

test('file names from the instance are reduced to one safe component', () => {
  assert.equal(safeAttachmentFileName('../../etc/passwd', SYS_ID), 'passwd');
  assert.equal(safeAttachmentFileName('a\\b\\c:d?.png', SYS_ID), 'c_d_.png');
  assert.equal(safeAttachmentFileName('..', SYS_ID), `attachment-${SYS_ID}`);
  assert.equal(safeAttachmentFileName('', SYS_ID), `attachment-${SYS_ID}`);
});

test('a download path outside the workspace is refused', () => {
  const ws = workspace();
  try {
    assert.throws(() => resolveDownloadTarget({ sysId: SYS_ID, overwrite: false, maxBytes: 10, filePath: '../../x.png' }, ws.root, ws.base), { code: 'E_SECURITY' });
    assert.throws(() => resolveDownloadTarget({ sysId: SYS_ID, overwrite: false, maxBytes: 10, filePath: path.join(os.tmpdir(), 'x.png') }, ws.root, ws.base), { code: 'E_SECURITY' });
    assert.equal(resolveDownloadTarget({ sysId: SYS_ID, overwrite: false, maxBytes: 10 }, ws.root, ws.base, '../evil.png'),
      path.join(ws.base, 'attachments', SYS_ID, 'evil.png'));
  } finally { ws.cleanup(); }
});

test('round trip: the published file is byte-identical, 0600, with no temp file left', () => {
  const ws = workspace();
  try {
    const bytes = crypto.randomBytes(70_000);
    const request = validateDownloadParams({ sys_id: SYS_ID });
    const result = saveDownloadedAttachment(reply(bytes), request, ws.root, ws.base);
    assert.equal(result.filePath, path.join(ws.base, 'attachments', SYS_ID, 'lineup.png'));
    assert.equal(result.relativePath, `attachments/${SYS_ID}/lineup.png`);
    assert.deepEqual(fs.readFileSync(result.filePath), bytes);
    assert.equal(result.sizeBytes, bytes.length);
    assert.equal(result.sourceTable, 'sc_cat_item');
    if (process.platform !== 'win32') assert.equal(fs.statSync(result.filePath).mode & 0o777, 0o600);
    assert.deepEqual(tempFiles(path.dirname(result.filePath)), []);
  } finally { ws.cleanup(); }
});

test('received bytes are counted: an understated size or wrong checksum is a transfer mismatch', () => {
  const bytes = Buffer.from('hello world');
  const request = validateDownloadParams({ sys_id: SYS_ID });
  assert.throws(() => decodeAttachmentReply(reply(bytes, { sizeBytes: 5 }), request), { code: 'E_TRANSFER_MISMATCH' });
  assert.throws(() => decodeAttachmentReply(reply(bytes, { sha256: '0'.repeat(64) }), request), { code: 'E_TRANSFER_MISMATCH' });
  assert.throws(() => decodeAttachmentReply(reply(bytes, { dataBase64: 'not base64!' }), request), { code: 'E_TRANSFER_MISMATCH' });
  assert.throws(() => decodeAttachmentReply({ success: true }, request), { code: 'E_TRANSFER_MISMATCH' });
});

test('more bytes than maxBytes is too large even when the helper reports a small size', () => {
  const bytes = Buffer.alloc(2048, 1);
  const request = validateDownloadParams({ sys_id: SYS_ID, maxBytes: 1024 });
  assert.throws(() => decodeAttachmentReply(reply(bytes, { sizeBytes: 10 }), request), { code: 'E_TOO_LARGE' });
});

test('an interrupted transfer (no valid data) leaves no file and no temp file', () => {
  const ws = workspace();
  try {
    const request = validateDownloadParams({ sys_id: SYS_ID });
    const truncated = reply(Buffer.from('complete payload'));
    truncated.dataBase64 = truncated.dataBase64.slice(0, 6);
    assert.throws(() => saveDownloadedAttachment(truncated, request, ws.root, ws.base), { code: 'E_TRANSFER_MISMATCH' });
    assert.equal(fs.existsSync(path.join(ws.base, 'attachments')), false);
  } finally { ws.cleanup(); }
});

test('an existing file is never replaced without overwrite, and is replaced with it', () => {
  const ws = workspace();
  try {
    const target = path.join(ws.base, 'out.bin');
    fs.writeFileSync(target, 'old');
    assert.throws(() => checkDownloadTarget(target, false), { code: 'E_FILE_EXISTS' });
    assert.throws(() => publishFile(ws.root, target, Buffer.from('new'), false), { code: 'E_FILE_EXISTS' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    publishFile(ws.root, target, Buffer.from('new'), true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.deepEqual(tempFiles(ws.base), []);
  } finally { ws.cleanup(); }
});

test('two downloads racing to one target: exactly one wins, the other gets E_FILE_EXISTS, no temp files remain', () => {
  const ws = workspace();
  try {
    const target = path.join(ws.base, 'race.bin');
    // The other writer publishes between this writer's check and its link.
    let raced = false;
    withLink((original) => (existing: fs.PathLike, newPath: fs.PathLike) => {
      if (!raced) {
        raced = true;
        publishFile(ws.root, target, Buffer.from('first'), false);
      }
      return original(existing, newPath);
    }, () => {
      assert.throws(() => publishFile(ws.root, target, Buffer.from('second'), false), { code: 'E_FILE_EXISTS' });
    });
    assert.equal(fs.readFileSync(target, 'utf8'), 'first');
    assert.deepEqual(tempFiles(ws.base), []);
  } finally { ws.cleanup(); }
});

test('a volume without hard links refuses instead of copying, and creates no target', () => {
  const ws = workspace();
  try {
    const target = path.join(ws.base, 'nolink.bin');
    withLink(() => () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); }, () => {
      assert.throws(() => publishFile(ws.root, target, Buffer.from('data'), false), { code: 'E_ATOMIC_PUBLISH_UNSUPPORTED' });
    });
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(tempFiles(ws.base), []);
  } finally { ws.cleanup(); }
});

test('a symlinked target or parent directory is refused, whatever overwrite says', { skip: process.platform === 'win32' }, () => {
  const ws = workspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-attach-outside-'));
  try {
    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(ws.base, 'link.txt'));
    assert.throws(() => publishFile(ws.root, path.join(ws.base, 'link.txt'), Buffer.from('x'), true), { code: 'E_SECURITY' });
    fs.symlinkSync(outside, path.join(ws.base, 'dirlink'));
    assert.throws(() => publishFile(ws.root, path.join(ws.base, 'dirlink', 'f.txt'), Buffer.from('x'), false), { code: 'E_SECURITY' });
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    ws.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
