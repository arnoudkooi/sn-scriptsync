import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REGISTRY_URL = 'https://registry.npmjs.org/@snutils%2Fsnu/latest';
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 800;

interface UpdateCache {
  checkedAt: number;
  latestVersion?: string;
}

interface UpdateResponse {
  ok: boolean;
  json(): Promise<{ version?: unknown }>;
}

type UpdateFetch = (url: string, init: { signal: AbortSignal }) => Promise<UpdateResponse>;

export interface LatestVersionOptions {
  timeoutMs?: number;
  fetchImpl?: UpdateFetch;
}

export interface UpdateCheckOptions {
  currentVersion: string;
  cacheFile?: string;
  now?: number;
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: UpdateFetch;
}

export function getUpdateCacheFile(): string {
  return path.join(os.homedir(), '.sn-scriptsync', 'snu-update-check.json');
}

export function shouldCheckForUpdates(
  env: NodeJS.ProcessEnv = process.env,
  stderrIsTty: boolean = process.stderr.isTTY === true
): boolean {
  if (!stderrIsTty) return false;
  if (env.CI || env.NO_UPDATE_NOTIFIER || env.SNU_DISABLE_UPDATE_CHECK) return false;
  if (env.npm_config_offline === 'true' || env.npm_config_offline === '1') return false;
  return true;
}

function parseVersion(version: string): { numbers: number[]; prerelease: string | null } | undefined {
  const match = version.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || null,
  };
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;

  for (let i = 0; i < next.numbers.length; i++) {
    if (next.numbers[i] !== installed.numbers[i]) {
      return next.numbers[i] > installed.numbers[i];
    }
  }

  return installed.prerelease !== null && next.prerelease === null;
}

function readCache(cacheFile: string): UpdateCache | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Partial<UpdateCache>;
    if (typeof parsed.checkedAt !== 'number') return undefined;
    return {
      checkedAt: parsed.checkedAt,
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : undefined,
    };
  } catch {
    return undefined;
  }
}

function writeCache(cacheFile: string, cache: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Update checks must never interfere with the requested CLI command.
  }
}

export async function fetchLatestVersion(options: LatestVersionOptions = {}): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const fetchImpl = options.fetchImpl ?? (fetch as unknown as UpdateFetch);
    const response = await fetchImpl(REGISTRY_URL, { signal: controller.signal });
    if (!response.ok) return undefined;
    const payload = await response.json();
    return typeof payload.version === 'string' ? payload.version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function getUpdateNotice(options: UpdateCheckOptions): Promise<string | undefined> {
  const now = options.now ?? Date.now();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const cacheFile = options.cacheFile ?? getUpdateCacheFile();
  const cached = readCache(cacheFile);

  if (cached && now - cached.checkedAt < intervalMs) return undefined;

  let latestVersion: string | undefined;

  try {
    latestVersion = await fetchLatestVersion({
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  } finally {
    writeCache(cacheFile, { checkedAt: now, latestVersion });
  }

  if (!latestVersion || !isNewerVersion(latestVersion, options.currentVersion)) return undefined;
  return (
    `\nUpdate available: snu v${options.currentVersion} -> v${latestVersion}\n` +
    'Run: npm install -g @snutils/snu@latest\n'
  );
}
