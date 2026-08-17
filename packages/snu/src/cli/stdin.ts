import * as fs from 'fs';
import * as path from 'path';

/**
 * Read all text from process.stdin asynchronously.
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Resolve content from either direct string, local file path, or stdin.
 * Strictly rejects conflicting sources (e.g. both value and file provided).
 */
export async function resolveContentInput(options: {
  value?: string;
  filePath?: string;
  allowStdin?: boolean;
}): Promise<string | undefined> {
  const { value, filePath, allowStdin = true } = options;

  if (value !== undefined && filePath !== undefined) {
    throw new Error('Conflicting arguments: provide either a direct value or --file <path>, not both.');
  }

  if (value !== undefined) {
    return value;
  }

  if (filePath !== undefined) {
    const resolved = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    return fs.readFileSync(resolved, 'utf8');
  }

  if (allowStdin && !process.stdin.isTTY) {
    return await readStdin();
  }

  return undefined;
}
