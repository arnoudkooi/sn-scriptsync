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

// On Windows npm is a .cmd shim, and Node refuses to spawn one without a
// shell since the CVE-2024-27980 fix (18.20 / 20.12 / 22): `snu update`
// died with "spawn EINVAL". Going through the shell resolves npm.cmd; the
// arguments are fixed literals, so nothing user-controlled reaches it.
export function npmInstallSpawnSpec(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
  options: { stdio: 'inherit'; shell: boolean; windowsHide: boolean };
} {
  return {
    command: 'npm',
    args: ['install', '--global', '@snutils/snu@latest'],
    options: { stdio: 'inherit', shell: platform === 'win32', windowsHide: true },
  };
}

export async function installLatestWithNpm(): Promise<void> {
  const spec = npmInstallSpawnSpec();
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, spec.options);
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`npm exited with code ${exitCode}.`);
  }
}
