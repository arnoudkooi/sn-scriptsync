import { execFile } from 'child_process';
import * as net from 'net';

/**
 * Port-level takeover helpers for the browser save channel (port 1978) and the
 * Agent API (port 1977). The graceful yield protocol only works while the
 * holder's port file is intact; when it isn't (orphaned `snu --mcp` bridge,
 * clobbered port file), these helpers identify the actual listener so the
 * extension can offer to stop it and take the port over.
 *
 * Mirrors packages/snu/src/cli/portReclaim.ts — the CLI and the extension are
 * separate builds with no shared runtime dependency.
 */

export interface PortListener {
	pid: number;
	command: string;
}

export type ListenerKind = 'snu' | 'vscode' | 'unknown';

function run(file: string, args: string[]): Promise<{ stdout: string }> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: 5_000, windowsHide: true }, (err, stdout) => {
			if (err) reject(err);
			else resolve({ stdout: String(stdout) });
		});
	});
}

/** Identify the process listening on 127.0.0.1:<port>, if any. */
export async function findPortListener(port: number): Promise<PortListener | null> {
	try {
		if (process.platform === 'win32') {
			return await findPortListenerWindows(port);
		}
		const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
		const pidLine = stdout.split('\n').find((line) => /^p\d+$/.test(line.trim()));
		if (!pidLine) return null;
		const pid = parseInt(pidLine.trim().slice(1), 10);
		if (!Number.isInteger(pid) || pid <= 0) return null;
		let command = '';
		try {
			const ps = await run('ps', ['-p', String(pid), '-o', 'command=']);
			command = ps.stdout.trim();
		} catch { /* process exited between the two calls */ }
		return { pid, command };
	} catch {
		return null; // lsof missing or nothing listening
	}
}

async function findPortListenerWindows(port: number): Promise<PortListener | null> {
	const { stdout } = await run('netstat', ['-ano', '-p', 'tcp']);
	const line = stdout
		.split('\n')
		.find((l) => l.includes('LISTENING') && (l.includes(`:${port} `) || l.trim().split(/\s+/)[1]?.endsWith(`:${port}`)));
	if (!line) return null;
	const parts = line.trim().split(/\s+/);
	const pid = parseInt(parts[parts.length - 1], 10);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	let command = '';
	try {
		const ps = await run('powershell', [
			'-NoProfile',
			'-Command',
			`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
		]);
		command = ps.stdout.trim();
	} catch {
		try {
			const tl = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
			command = tl.stdout.split(',')[0]?.replace(/"/g, '').trim() || '';
		} catch { /* leave empty */ }
	}
	return { pid, command };
}

/** Classify a listener's command line: an snu bridge, a VS Code-family host, or foreign. */
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

/**
 * Stop a listener: SIGTERM first (an snu bridge shuts down cleanly on it and
 * removes its port files), escalate to SIGKILL if the port stays bound.
 */
export async function terminateListener(pid: number, port: number): Promise<boolean> {
	const waitFree = async (rounds: number): Promise<boolean> => {
		for (let i = 0; i < rounds; i++) {
			if (await isPortFree(port)) return true;
			await new Promise((r) => setTimeout(r, 150));
		}
		return isPortFree(port);
	};

	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		// Already gone (or not permitted) — verify via the port itself.
		return waitFree(3);
	}
	if (await waitFree(20)) return true;
	try {
		process.kill(pid, 'SIGKILL');
	} catch { /* ignore */ }
	return waitFree(10);
}
