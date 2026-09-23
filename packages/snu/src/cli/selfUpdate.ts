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

const NPM_INSTALL_ARGS = ['install', '--global', '@snutils/snu@latest'];

// On Windows npm is a .cmd shim, and Node refuses to spawn one without a
// shell since the CVE-2024-27980 fix (18.20 / 20.12 / 22): `snu update`
// died with "spawn EINVAL". Going through the shell resolves npm.cmd. The
// whole command line is one fixed literal there (a shell plus an args array
// draws Node's DEP0190 warning, and nothing user-controlled is in it anyway).
export function npmInstallSpawnSpec(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
  options: { stdio: 'inherit'; shell: boolean; windowsHide: boolean };
} {
  if (platform === 'win32') {
    return {
      command: ['npm', ...NPM_INSTALL_ARGS].join(' '),
      args: [],
      options: { stdio: 'inherit', shell: true, windowsHide: true },
    };
  }
  return {
    command: 'npm',
    args: [...NPM_INSTALL_ARGS],
    options: { stdio: 'inherit', shell: false, windowsHide: true },
  };
}

export const MANUAL_UPDATE_COMMAND = 'npm install -g @snutils/snu@latest';

/** The automatic path failed; the manual one is always available, so name it. */
export function updateFailure(reason: string): Error {
  return Object.assign(new Error(`${reason}. Update by hand with: ${MANUAL_UPDATE_COMMAND}`), { code: 'E_UPDATE_FAILED' });
}

export async function installLatestWithNpm(): Promise<void> {
  const spec = npmInstallSpawnSpec();
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, spec.options);
    child.once('error', (err: any) => reject(updateFailure(`Could not start npm (${err?.message || err})`)));
    child.once('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw updateFailure(`npm exited with code ${exitCode}`);
  }
}
