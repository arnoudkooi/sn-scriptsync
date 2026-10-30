import { spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScriptSyncClientError, checkHealth } from '../client.js';
import { inspectBridge } from './daemon.js';
import { HealthResponse } from '../types.js';

/**
 * A standalone bridge that outlives the process that asked for it.
 *
 * `snu --mcp` used to host the bridge in-process, so the bridge (and its
 * token) died with whichever MCP session happened to create it, and every
 * other session lost its connection. The bridge now runs as its own detached
 * `snu serve` process: it survives the session that spawned it, and every
 * session attaches to it through the normal discovery path until `snu stop`.
 *
 * The detached child never reclaims ports. The caller has already decided that
 * nothing healthy answers; if another session wins the race to bind the
 * helper's WebSocket port, the child's bind fails and it exits — the winner is
 * attached to, never displaced.
 */

/** Set in the environment of a detached child: bind or exit, never reclaim. */
export const DETACHED_CHILD_ENV = 'SNU_DETACHED_CHILD';

/** `SNU_MCP_BRIDGE=inprocess|detached` overrides the platform default for `snu --mcp`. */
export const MCP_BRIDGE_ENV = 'SNU_MCP_BRIDGE';

export type McpBridgeMode = 'detached' | 'inprocess';

export function isDetachedChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DETACHED_CHILD_ENV] === '1';
}

/**
 * How `snu --mcp` starts a bridge when none answers.
 *
 * Detached is the default where its process lifetime has been exercised for
 * real. Windows stays in-process until a session-lifetime smoke test there
 * (start through an MCP client, close the owning session, run a command from
 * another session, then `snu stop`) has passed; `SNU_MCP_BRIDGE=detached` opts
 * in. An explicit value always wins over the platform default.
 */
export function mcpBridgeMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): McpBridgeMode {
  const requested = (env[MCP_BRIDGE_ENV] || '').trim().toLowerCase();
  if (requested === 'inprocess' || requested === 'detached') return requested;
  return platform === 'win32' ? 'inprocess' : 'detached';
}

/** Where a detached bridge writes its output (~/.sn-scriptsync/snu-bridge.log). */
export function bridgeLogPath(home: string = os.homedir()): string {
  return path.join(home, '.sn-scriptsync', 'snu-bridge.log');
}

/** The package's own CLI entry, so the child runs the same snu as the parent. */
export function snuBinPath(): string {
  return path.resolve(__dirname, '..', '..', 'bin', 'snu.js');
}

export interface DetachedSpawnRequest {
  /** Workspace the bridge serves; relative file paths resolve under it. */
  cwd: string;
  httpPort?: number;
  wsPort?: number;
  execPath?: string;
  binPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DetachedSpawnPlan {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/**
 * Build the spawn call without running it.
 *
 * `detached` puts the child in its own process group/session on POSIX, so the
 * terminal or MCP host closing does not take it down, and on Windows gives it
 * its own console — which `windowsHide` keeps invisible. stdio must not be
 * inherited: a pipe to a parent that exits would end the child on its next
 * write.
 */
export function planDetachedSpawn(request: DetachedSpawnRequest, logFd: number | 'ignore'): DetachedSpawnPlan {
  const args = [request.binPath ?? snuBinPath(), 'serve', '--json'];
  if (request.httpPort !== undefined) args.push('--port', String(request.httpPort));
  if (request.wsPort !== undefined) args.push('--ws', String(request.wsPort));
  return {
    command: request.execPath ?? process.execPath,
    args,
    options: {
      cwd: request.cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...(request.env ?? process.env), [DETACHED_CHILD_ENV]: '1' },
    },
  };
}

export interface SpawnedBridge {
  pid: number;
  logFile?: string;
}

export interface SpawnedChild {
  pid?: number;
  unref(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
  removeListener(event: 'spawn' | 'error', listener: (...args: any[]) => void): unknown;
}

export type SpawnImpl = (command: string, args: string[], options: SpawnOptions) => SpawnedChild;

/**
 * Spawn the detached bridge and resolve once the OS has actually started it.
 *
 * spawn() reports most failures (missing executable, bad cwd, EACCES) through
 * an asynchronous 'error' event, not a throw or a missing pid. Without a
 * listener that event is an uncaught exception that ends the calling process —
 * for `snu --mcp` that turned "fall back to an in-process bridge" into a
 * crashed MCP server. So: wait for 'spawn' or 'error', and keep a listener for
 * the child's whole life so a late error is never fatal to the parent.
 */
export async function spawnDetachedBridge(
  request: DetachedSpawnRequest,
  deps: { spawnImpl?: SpawnImpl; logFile?: string | null } = {}
): Promise<SpawnedBridge> {
  const spawnImpl = deps.spawnImpl ?? (spawn as unknown as SpawnImpl);
  const logFile = deps.logFile === undefined ? bridgeLogPath() : deps.logFile;

  let logFd: number | 'ignore' = 'ignore';
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      logFd = fs.openSync(logFile, 'a', 0o600);
    } catch {
      logFd = 'ignore'; // a log is a convenience, never a reason not to start
    }
  }

  try {
    const plan = planDetachedSpawn(request, logFd);
    let child: SpawnedChild;
    try {
      child = spawnImpl(plan.command, plan.args, plan.options);
    } catch (err: any) {
      throw new ScriptSyncClientError(`Could not spawn a detached bridge process: ${err?.message || err}`, 'E_SPAWN_FAILED');
    }
    child.on('error', () => { /* reported below, or irrelevant once the child runs on its own */ });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { child.removeListener('error', onError); resolve(); };
      const onError = (err: Error) => {
        child.removeListener('spawn', onSpawn);
        reject(new ScriptSyncClientError(`Could not spawn a detached bridge process: ${err?.message || err}`, 'E_SPAWN_FAILED'));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    if (!child.pid) {
      throw new ScriptSyncClientError('Could not spawn a detached bridge process.', 'E_SPAWN_FAILED');
    }
    child.unref();
    return { pid: child.pid, logFile: logFd === 'ignore' ? undefined : logFile || undefined };
  } finally {
    // The child holds its own copy of the descriptor.
    if (typeof logFd === 'number') {
      try { fs.closeSync(logFd); } catch {}
    }
  }
}

export interface DetachedReadyProbes {
  /** Health of whatever bridge now serves, via discovery or the HTTP port. */
  probe: () => Promise<HealthResponse | undefined>;
  isAlive: (pid: number) => boolean;
}

export interface DetachedReady {
  health: HealthResponse;
  /** False when a different bridge (a racing session's) answered instead. */
  ownChild: boolean;
}

/**
 * Wait until a bridge answers after spawning one.
 *
 * Any healthy bridge ends the wait, not only our child: when two sessions spawn
 * at once one child loses the port race and exits, and the winner is exactly
 * what the loser's session should attach to. A dead child with nothing
 * answering fails fast instead of waiting out the timeout.
 */
export async function waitForDetachedBridge(
  childPid: number,
  probes: DetachedReadyProbes,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<DetachedReady> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const health = await probes.probe().catch(() => undefined);
    if (health) return { health, ownChild: health.pid === childPid };
    if (!probes.isAlive(childPid)) {
      // One more probe: the child may have lost a race to a bridge that only
      // became healthy after the previous probe.
      const late = await probes.probe().catch(() => undefined);
      if (late) return { health: late, ownChild: false };
      throw new ScriptSyncClientError(
        `The detached bridge (PID ${childPid}) exited before it answered. See ${bridgeLogPath()}.`,
        'E_SPAWN_FAILED'
      );
    }
    if (Date.now() >= deadline) {
      throw new ScriptSyncClientError(
        `The detached bridge (PID ${childPid}) did not answer within ${timeoutMs / 1000}s. See ${bridgeLogPath()}.`,
        'E_SPAWN_FAILED'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Guard for reclaimPort when the caller is about to start a bridge.
 *
 * "Nothing answered" was true when the caller looked, not necessarily now: a
 * session that started a moment earlier may hold the WebSocket port while its
 * HTTP side is still binding. Give such a bridge a short grace period to answer
 * before treating its port as held by a dead process.
 */
export function servingGuard(
  probe: () => Promise<HealthResponse | undefined>,
  options: { graceMs?: number; intervalMs?: number } = {}
): () => Promise<boolean> {
  const graceMs = options.graceMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 100;
  return async () => {
    const deadline = Date.now() + graceMs;
    while (true) {
      if (await probe().catch(() => undefined)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };
}

/**
 * Probe for whatever bridge now serves: the normal descriptor path first (it
 * validates PID and token), then the HTTP port's public health endpoint.
 */
export async function probeServingBridge(cwd: string, httpPort: number): Promise<HealthResponse | undefined> {
  try {
    const status = await inspectBridge({ cwd, healthPort: httpPort });
    if (status.running) return status.health;
  } catch {
    /* descriptor may be mid-write */
  }
  try {
    return await checkHealth(httpPort);
  } catch {
    return undefined;
  }
}
