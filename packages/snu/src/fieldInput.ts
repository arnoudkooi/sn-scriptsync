import { readWorkspaceFile } from './server/attachmentInput.js';

export function parseFieldValues(value: unknown): Record<string, any> {
  let fields: any;
  try { fields = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw Object.assign(new Error('Field values must contain valid JSON'), { code: 'E_INVALID_PARAMS' }); }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw Object.assign(new Error('Field values must be a JSON object'), { code: 'E_INVALID_PARAMS' });
  }
  return fields as Record<string, any>;
}

export function resolveFieldValues(input: Record<string, any>): Record<string, any> {
  if (input.fields !== undefined && input.fieldsFile !== undefined) {
    throw Object.assign(new Error('Provide fields or fieldsFile, not both'), { code: 'E_INVALID_PARAMS' });
  }
  if (input.fieldsFile !== undefined) {
    return parseFieldValues(readWorkspaceFile(input.fieldsFile, process.cwd()).toString('utf8'));
  }
  return input.fields === undefined ? {} : parseFieldValues(input.fields);
}
