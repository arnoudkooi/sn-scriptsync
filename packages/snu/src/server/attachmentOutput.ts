/**
 * Downloaded attachment bytes: validation and the file-write contract.
 *
 * attachmentInput.ts guards reading files that already exist. Writing needs
 * more: a unique temp file per download, exclusive creation, no symlink in the
 * path, a size bound on the bytes actually received, and an atomic publish
 * that never overwrites by accident and never shows a half-written file.
 *
 * Threat model: the checks keep remote input (an attachment file name from
 * the instance, a path from an agent) from steering a write outside the
 * workspace. A local process running as the same user that swaps a path
 * component between check and write is out of scope; it could write the
 * workspace directly.
 *
 * Mirrored verbatim into packages/snu/src/server/attachmentOutput.ts; the
 * bridge parity test fails when the copies differ.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Default and maximum size of one downloaded attachment. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface DownloadRequest {
	sysId: string;
	filePath?: string;
	overwrite: boolean;
	maxBytes: number;
}

export interface DecodedAttachment {
	bytes: Buffer;
	sha256: string;
	fileName: string;
	contentType: string;
	sourceTable: string | null;
	sourceSysId: string | null;
}

function fail(code: string, message: string, details?: any): never {
	throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

export function validateDownloadParams(params: Record<string, any>): DownloadRequest {
	const sysId = params?.sys_id;
	if (typeof sysId !== 'string' || !/^[a-f0-9]{32}$/i.test(sysId)) {
		fail('E_INVALID_PARAMS', 'download_attachment requires the 32-character sys_id of a sys_attachment record');
	}
	const filePath = params.filePath;
	if (filePath !== undefined && (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0'))) {
		fail('E_INVALID_PARAMS', 'filePath must be a non-empty path');
	}
	const overwrite = params.overwrite ?? false;
	if (typeof overwrite !== 'boolean') fail('E_INVALID_PARAMS', 'overwrite must be true or false');
	const maxBytes = params.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
	if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_ATTACHMENT_BYTES) {
		fail('E_INVALID_PARAMS', `maxBytes must be an integer from 1 to ${DEFAULT_MAX_ATTACHMENT_BYTES}`);
	}
	return { sysId: sysId.toLowerCase(), ...(filePath !== undefined ? { filePath } : {}), overwrite, maxBytes };
}

/** A file name from the instance, reduced to one safe path component. */
export function safeAttachmentFileName(name: unknown, sysId: string): string {
	const base = String(name ?? '').split(/[\\/]/).pop() || '';
	const cleaned = base
		.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
		.replace(/^[\s.]+|[\s.]+$/g, '')
		.slice(0, 200);
	return cleaned || `attachment-${sysId}`;
}

/** Where the download lands: the caller's filePath, or attachments/<sys_id>/<name> under the instance folder. */
export function resolveDownloadTarget(request: DownloadRequest, root: string, base: string, fileName?: string): string {
	if (!root) fail('E_INVALID_PARAMS', 'A workspace is required to save a download');
	const resolvedRoot = path.resolve(root);
	const target = request.filePath !== undefined
		? path.resolve(base, request.filePath)
		: path.join(path.resolve(base), 'attachments', request.sysId, safeAttachmentFileName(fileName, request.sysId));
	const relative = path.relative(resolvedRoot, target);
	if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
		fail('E_SECURITY', 'The download path must be a file inside the workspace');
	}
	return target;
}

function lstatOrNull(file: string): fs.Stats | null {
	try {
		return fs.lstatSync(file);
	} catch (error: any) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

/**
 * Refuse a target that cannot be published to, before any bytes move: a
 * symlink (always), a directory, or an existing file without overwrite.
 * publishFile checks again; this only saves a wasted transfer.
 */
export function checkDownloadTarget(target: string, overwrite: boolean): void {
	const existing = lstatOrNull(target);
	if (!existing) return;
	if (existing.isSymbolicLink()) fail('E_SECURITY', 'The download target is a symbolic link');
	if (!existing.isFile()) fail('E_INVALID_PARAMS', 'The download target exists and is not a regular file');
	if (!overwrite) fail('E_FILE_EXISTS', `${target} already exists. Pass overwrite: true to replace it.`, { filePath: target });
}

/** Decode and verify the helper's reply. Never trusts its sizes: counts the bytes. */
export function decodeAttachmentReply(reply: Record<string, any>, request: DownloadRequest): DecodedAttachment {
	const data = reply?.dataBase64;
	if (typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
		fail('E_TRANSFER_MISMATCH', 'The helper returned no valid attachment data');
	}
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
	if ((data.length / 4) * 3 - padding > request.maxBytes) {
		fail('E_TOO_LARGE', `The attachment is larger than ${request.maxBytes} bytes`, { maxBytes: request.maxBytes });
	}
	const bytes = Buffer.from(data, 'base64');
	if (bytes.length > request.maxBytes) {
		fail('E_TOO_LARGE', `The attachment is larger than ${request.maxBytes} bytes`, { maxBytes: request.maxBytes });
	}
	const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
	if (reply.sizeBytes !== bytes.length || String(reply.sha256 || '').toLowerCase() !== sha256) {
		fail('E_TRANSFER_MISMATCH', 'The received attachment does not match the size and checksum the helper reported', {
			receivedBytes: bytes.length, reportedBytes: reply.sizeBytes,
		});
	}
	return {
		bytes,
		sha256,
		fileName: typeof reply.fileName === 'string' ? reply.fileName : '',
		contentType: typeof reply.contentType === 'string' && reply.contentType ? reply.contentType : 'application/octet-stream',
		sourceTable: typeof reply.tableName === 'string' && reply.tableName ? reply.tableName : null,
		sourceSysId: typeof reply.tableSysId === 'string' && reply.tableSysId ? reply.tableSysId : null,
	};
}

/** Create missing directories below root one at a time, refusing any symlinked component. */
function ensureDirectory(root: string, dir: string): void {
	const resolvedRoot = path.resolve(root);
	let current = resolvedRoot;
	for (const component of path.relative(resolvedRoot, dir).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		let stat = lstatOrNull(current);
		if (!stat) {
			try {
				fs.mkdirSync(current);
			} catch (error: any) {
				if (error.code !== 'EEXIST') throw error;
			}
			stat = fs.lstatSync(current);
		}
		if (stat.isSymbolicLink()) fail('E_SECURITY', 'Symbolic links are not allowed in the download path');
		if (!stat.isDirectory()) fail('E_INVALID_PARAMS', `${current} is not a directory`);
	}
}

/**
 * Verify the helper's reply, publish it, and describe the result. Both hosts
 * return exactly this object. `relativePath` is relative to the instance
 * folder, which is how upload_attachment resolves a relative filePath.
 */
export function saveDownloadedAttachment(reply: Record<string, any>, request: DownloadRequest, root: string, base: string) {
	const decoded = decodeAttachmentReply(reply, request);
	const target = resolveDownloadTarget(request, root, base, decoded.fileName);
	publishFile(root, target, decoded.bytes, request.overwrite);
	return {
		downloaded: true,
		sys_id: request.sysId,
		filePath: target,
		relativePath: path.relative(path.resolve(base), target).split(path.sep).join('/'),
		fileName: decoded.fileName || path.basename(target),
		sizeBytes: decoded.bytes.length,
		contentType: decoded.contentType,
		sha256: decoded.sha256,
		sourceTable: decoded.sourceTable,
		sourceSysId: decoded.sourceSysId,
	};
}

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

/**
 * Write bytes to target atomically. The bytes go to a unique temp file next to
 * the target (exclusive create, 0600, no symlink follow, fsync). Without
 * overwrite the temp file is hard-linked to the target, which fails with
 * EEXIST when another writer got there first; where hard links are not
 * supported this refuses instead of copying. With overwrite it is renamed over
 * the target. The temp file never outlives the call.
 */
export function publishFile(root: string, target: string, bytes: Buffer, overwrite: boolean): void {
	ensureDirectory(root, path.dirname(target));
	checkDownloadTarget(target, overwrite);

	const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.partial`);
	const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
	const fd = fs.openSync(temp, flags, 0o600);
	try {
		try {
			let offset = 0;
			while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		if (overwrite) {
			fs.renameSync(temp, target);
			return;
		}
		try {
			fs.linkSync(temp, target);
		} catch (error: any) {
			if (error.code === 'EEXIST') fail('E_FILE_EXISTS', `${target} already exists. Pass overwrite: true to replace it.`, { filePath: target });
			if (LINK_UNSUPPORTED.has(error.code)) {
				fail('E_ATOMIC_PUBLISH_UNSUPPORTED', 'This volume cannot publish a file atomically without overwriting. Choose another folder, or pass overwrite: true for a path that does not exist yet.', { errno: error.code });
			}
			throw error;
		}
	} finally {
		try { fs.unlinkSync(temp); } catch { /* renamed, or already gone */ }
	}
}
