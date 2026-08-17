import * as crypto from 'crypto';

/**
 * Deterministically serialize a JavaScript value to canonical JSON.
 * Object keys are sorted alphabetically at every level.
 */
export function canonicalJson(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/**
 * Compute SHA-256 payload hash over [protocolVersion, instanceOrigin, command, canonicalParams].
 */
export function computePayloadHash(
  protocolVersion: number,
  instanceOrigin: string,
  command: string,
  params: any
): string {
  let origin = (instanceOrigin || '').toLowerCase().trim();
  try {
    origin = new URL(origin).origin.toLowerCase();
  } catch {
    origin = origin.replace(/\/+$/, '');
  }

  const canonicalString = canonicalJson([
    protocolVersion,
    origin,
    command,
    params || {},
  ]);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}
