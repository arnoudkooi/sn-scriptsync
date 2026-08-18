import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fetchLatestVersion, isNewerVersion } from './updateCheck.js';

export type UpdateAction = 'current' | 'install' | 'npx';

export interface UpdateDecision {
  action: UpdateAction;
  currentVersion: string;
  latestVersion: string;
}

export function isNpxExecution(
  executablePath: string = process.argv[1] || '',
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const normalized = executablePath.split(path.sep).join('/');
  return normalized.includes('/_npx/') || env.npm_command === 'exec';
}

export function decideUpdate(currentVersion: string, latestVersion: string, viaNpx: boolean): UpdateDecision {
  if (!isNewerVersion(latestVersion, currentVersion)) {
    return { action: 'current', currentVersion, latestVersion };
  }
  return {
    action: viaNpx ? 'npx' : 'install',
    currentVersion,
    latestVersion,
  };
}

export async function checkForCliUpdate(currentVersion: string): Promise<UpdateDecision> {
  const latestVersion = await fetchLatestVersion({ timeoutMs: 3_000 });
  if (!latestVersion) {
    throw new Error('Could not retrieve the latest @snutils/snu version from npm.');
  }
  return decideUpdate(currentVersion, latestVersion, isNpxExecution());
}

export async function installLatestWithNpm(): Promise<void> {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(npmCommand, ['install', '--global', '@snutils/snu@latest'], {
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`npm exited with code ${exitCode}.`);
  }
}
