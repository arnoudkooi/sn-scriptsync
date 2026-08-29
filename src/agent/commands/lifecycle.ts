import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { getRuntime } from '../runtime';

/**
 * Remote lifecycle control for an editor-hosted bridge.
 *
 * The standalone bridge has always accepted a `yield`; the editor-hosted one
 * did not, which is why recovering the 2026-08-29 incident meant finding and
 * killing an extension-host PID by hand. `snu` can now ask the owning window to
 * stand down or cycle itself, and never has to signal an editor process.
 */

const yieldCommand: CommandHandler = {
	name: 'yield',
	noInstance: true,
	docs: {
		summary: 'Ask this bridge to release ports 1977/1978 and stop.',
		request: { command: 'yield', id: 'yield_1' },
		response: { status: 'success', result: { stopped: true } },
		notes: 'Graceful: the lifecycle serialises this against any start already in flight. The editor window stays open; click sn-scriptsync to start again.',
	},
	async handle() {
		const runtime = getRuntime();
		if (!runtime.stopBridge) {
			throw new AgentError('E_UNSUPPORTED_HOST', 'This bridge host does not support remote stop.');
		}
		// Answer before the listeners go away, or the caller sees a dropped
		// socket instead of a result.
		setTimeout(() => { void runtime.stopBridge!(); }, 50);
		return { stopped: true, hostKind: 'vscode' };
	},
};

const restartCommand: CommandHandler = {
	name: 'restart',
	noInstance: true,
	docs: {
		summary: 'Stop and restart this bridge in place, keeping the same editor window.',
		request: { command: 'restart', id: 'restart_1' },
		response: { status: 'success', result: { restarting: true } },
		notes: 'Recovery path for a wedged editor-hosted bridge. The reply is sent before the transports cycle, so the caller should poll /api/health for the new pid.',
	},
	async handle() {
		const runtime = getRuntime();
		if (!runtime.restartBridge) {
			throw new AgentError('E_UNSUPPORTED_HOST', 'This bridge host does not support remote restart.');
		}
		setTimeout(() => { void runtime.restartBridge!(); }, 50);
		return { restarting: true, hostKind: 'vscode' };
	},
};

export const lifecycleCommands: CommandHandler[] = [yieldCommand, restartCommand];
