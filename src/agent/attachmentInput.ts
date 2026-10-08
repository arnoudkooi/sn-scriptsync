import * as fs from 'fs';
import * as path from 'path';

const mimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json',
  '.xml': 'application/xml', '.html': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function readWorkspaceFile(filePath: string, root: string, base = root): Buffer {
  if (!root || typeof filePath !== 'string' || !filePath) fail('E_INVALID_PARAMS', 'A workspace and file path are required');
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(base, filePath);
  const relative = path.relative(resolvedRoot, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    fail('E_SECURITY', 'File path must be inside the workspace');
  }
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) fail('E_SECURITY', 'Symbolic links are not allowed for file input');
  }
  if (!fs.statSync(file).isFile()) fail('E_INVALID_PARAMS', 'File input must name a regular file');
  return fs.readFileSync(file);
}

export function resolveAttachment(params: Record<string, any>, root: string, base = root) {
  const { table, sys_id, filePath } = params;
  if (typeof table !== 'string' || !/^[a-zA-Z0-9_]+$/.test(table) ||
      typeof sys_id !== 'string' || !/^[a-f0-9]{32}$/i.test(sys_id)) {
    fail('E_INVALID_PARAMS', 'Attachment requires a valid table and 32-character sys_id');
  }
  if (filePath !== undefined && params.imageData !== undefined) fail('E_INVALID_PARAMS', 'Provide either filePath or imageData, not both');
  let fileName = params.fileName;
  let imageData = params.imageData;
  let contentType = params.contentType;
  if (filePath !== undefined) {
    let bytes: Buffer;
    try { bytes = readWorkspaceFile(filePath, root, base); }
    catch (error: any) {
      if (error.code === 'E_SECURITY' || error.code === 'E_INVALID_PARAMS') throw error;
      fail('E_INVALID_PARAMS', `Cannot read attachment: ${error.message}`);
    }
    imageData = bytes.toString('base64');
    fileName ??= path.basename(filePath);
    contentType ??= mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  }
  if (typeof imageData === 'string') imageData = imageData.replace(/^data:[\w.+-]+\/[\w.+-]+;base64,/, '');
  if (typeof imageData !== 'string' || !imageData || imageData.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(imageData)) {
    fail('E_INVALID_PARAMS', 'Attachment requires valid base64 imageData or a non-empty file');
  }
  if (typeof fileName !== 'string' || !fileName || /[\\/\0\r\n]/.test(fileName) || fileName === '.' || fileName === '..') {
    fail('E_INVALID_PARAMS', 'Attachment requires a safe fileName (or filePath)');
  }
  contentType ??= 'image/png';
  if (typeof contentType !== 'string' || /[\r\n\0]/.test(contentType)) fail('E_INVALID_PARAMS', 'Invalid attachment contentType');
  return { tableName: table, recordSysId: sys_id, fileName, imageData, contentType };
}
