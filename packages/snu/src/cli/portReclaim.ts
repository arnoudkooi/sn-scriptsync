import { execFile } from 'child_process';
import * as net from 'net';

/**
 * Port-level bridge reclaim. Port-file discovery can go stale (the file gets
 * deleted or overwritten by another bridge host) while the process itself keeps
 * ports 1977/1978 bound. These helpers find the actual listener on a port,
 * classify it, and stop it so lifecycle commands work from ground truth instead
 * of trusting the port files.
 */

export interface PortListener {
  pid: number;
  command: string;
}

export type ListenerKind = 'snu' | 'vscode' | 'unknown';

export type ExecImpl = (
  file: string,
  args: string[]
) => Promise<{ stdout: string }>;

function defaultExec(file: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });
}

/** Identify the process listening on 127.0.0.1:<port>, if any. */
export async function findPortListener(
  port: number,
  execImpl: ExecImpl = defaultExec,
  platform: NodeJS.Platform = process.platform
): Promise<PortListener | null> {
  try {
    if (platform === 'win32') {
      return await findPortListenerWindows(port, execImpl);
    }
    const { stdout } = await execImpl('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
    const pidLine = stdout.split('\n').find((line) => /^p\d+$/.test(line.trim()));
    if (!pidLine) return null;
    const pid = parseInt(pidLine.trim().slice(1), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    let command = '';
    try {
      const ps = await execImpl('ps', ['-p', String(pid), '-o', 'command=']);
      command = ps.stdout.trim();
    } catch {
      // Process may have exited between the two calls.
    }
    return { pid, command };
  } catch {
    // lsof missing or nothing listening — treat as unknown/free.
    return null;
  }
}

async function findPortListenerWindows(port: number, execImpl: ExecImpl): Promise<PortListener | null> {
  const { stdout } = await execImpl('netstat', ['-ano', '-p', 'tcp']);
  const line = stdout
    .split('\n')
    .find((l) => l.includes('LISTENING') && (l.includes(`:${port} `) || l.trim().split(/\s+/)[1]?.endsWith(`:${port}`)));
  if (!line) return null;
  const parts = line.trim().split(/\s+/);
  const pid = parseInt(parts[parts.length - 1], 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let command = '';
  try {
    const ps = await execImpl('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
    command = ps.stdout.trim();
  } catch {
    try {
      const tl = await execImpl('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      command = tl.stdout.split(',')[0]?.replace(/"/g, '').trim() || '';
    } catch {}
  }
  return { pid, command };
}

/** Classify a listener's command line: one of ours, a VS Code host, or foreign. */
export function classifyListener(command: string): ListenerKind {
  const c = (command || '').toLowerCase();
  if (
    c.includes('@snutils/snu') ||
    c.includes('@snutils\\snu') ||
    /[\\/]\.bin[\\/]snu(\s|$)/.test(c) ||
    /[\\/]snu[\\/]bin[\\/]snu\.js/.test(c) ||
    /(^|\s|[\\/])snu(\.js)?\s+(--mcp|serve|restart)(\s|$)/.test(c) ||
    c.includes('sn-scriptsync/packages/snu')
  ) {
    return 'snu';
  }
  if (
    c.includes('code helper') ||
    c.includes('extensionhost') ||
    c.includes('vscode') ||
    c.includes('visual studio code') ||
    c.includes('cursor helper') ||
    c.includes('windsurf helper')
  ) {
    return 'vscode';
  }
  return 'unknown';
}

/** True when nothing is bound to 127.0.0.1:<port>. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

export interface TerminateHooks {
  killImpl?: (pid: number, signal: NodeJS.Signals) => void;
  portFreeImpl?: (port: number) => Promise<boolean>;
  delayMs?: number;
}

/**
 * Stop a listener: SIGTERM first (the standalone bridge shuts down cleanly on
 * it, removing its port files), escalate to SIGKILL if the port stays bound.
 */
export async function terminateListener(
  pid: number,
  port: number,
  hooks: TerminateHooks = {}
): Promise<boolean> {
  const kill = hooks.killImpl ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s));
  const portFree = hooks.portFreeImpl ?? isPortFree;
  const delay = hooks.delayMs ?? 150;
  const waitFree = async (rounds: number): Promise<boolean> => {
    for (let i = 0; i < rounds; i++) {
      if (await portFree(port)) return true;
      await new Promise((r) => setTimeout(r, delay));
    }
    return portFree(port);
  };

  try {
    kill(pid, 'SIGTERM');
  } catch {
    // Already gone (or not permitted) — verify via the port itself.
    return waitFree(3);
  }
  if (await waitFree(20)) return true;
  try {
    kill(pid, 'SIGKILL');
  } catch {}
  return waitFree(10);
}

export interface ReclaimResult {
  status: 'free' | 'reclaimed' | 'refused_vscode' | 'refused_foreign' | 'failed';
  listener?: PortListener;
}

export interface ReclaimOptions {
  /** Also stop listeners that don't look like an snu bridge. Never applies to VS Code hosts. */
  force?: boolean;
  findImpl?: (port: number) => Promise<PortListener | null>;
  terminateImpl?: (pid: number, port: number) => Promise<boolean>;
}

/**
 * Make <port> available: no-op when free, stop an orphaned snu bridge, refuse
 * a VS Code-hosted bridge (stop it from VS Code) or, without --force, any
 * process that isn't recognizably ours.
 */
export async function reclaimPort(port: number, options: ReclaimOptions = {}): Promise<ReclaimResult> {
  const find = options.findImpl ?? findPortListener;
  const terminate = options.terminateImpl ?? terminateListener;

  const listener = await find(port);
  if (!listener) return { status: 'free' };

  const kind = classifyListener(listener.command);
  if (kind === 'vscode') return { status: 'refused_vscode', listener };
  if (kind === 'unknown' && !options.force) return { status: 'refused_foreign', listener };

  const stopped = await terminate(listener.pid, port);
  return { status: stopped ? 'reclaimed' : 'failed', listener };
}
