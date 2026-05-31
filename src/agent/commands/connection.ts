import * as fs from 'fs';
import * as path from 'path';
import { CommandHandler } from '../types';
import { ExtensionUtils } from '../../ExtensionUtils';

const eu = new ExtensionUtils();

const check_connection: CommandHandler = {
	name: 'check_connection',
	noInstance: true,
	docs: {
		summary: 'Verify that the WS server is running and a browser tab is connected.',
		request: { command: 'check_connection', id: 'chk_1' },
		response: { status: 'success', result: { ready: true, serverRunning: true, browserConnected: true, clientCount: 1 } },
	},
	async handle(ctx) {
		const serverRunning = ctx.isServerRunning();
		const browserConnected = serverRunning && ctx.hasBrowserClient();

		if (!serverRunning) {
			return {
				ready: false,
				serverRunning: false,
				browserConnected: false,
				message: 'WebSocket server not running. Click sn-scriptsync in VS Code status bar to start.',
			};
		}
		if (!browserConnected) {
			return {
				ready: false,
				serverRunning: true,
				browserConnected: false,
				message: 'No browser connected - open helper tab with /token',
			};
		}
		return {
			ready: true,
			serverRunning: true,
			browserConnected: true,
			message: 'Connected and ready',
		};
	},
};

const get_sync_status: CommandHandler = {
	name: 'get_sync_status',
	noInstance: true,
	docs: {
		summary: 'Inspect the extension-wide pending-file queue.',
		response: { status: 'success', result: { serverRunning: true, pendingFiles: [], pendingCount: 0, isPaused: false } },
	},
	async handle(ctx) {
		// The queue state lives in extension.ts. The runtime exposes it via the
		// syncState shim to keep this module host-agnostic.
		const state = getSyncState();
		return {
			serverRunning: ctx.isServerRunning(),
			pendingFiles: state.pendingFiles,
			pendingCount: state.pendingFiles.length,
			isPaused: state.isPaused,
		};
	},
};

const get_last_error: CommandHandler = {
	name: 'get_last_error',
	docs: {
		summary: 'Read the last remote sync error (written by the WS bridge).',
	},
	async handle(ctx) {
		const errorFile = path.join(ctx.instanceFolder, '_last_error.json');
		if (!fs.existsSync(errorFile)) {
			return { hasError: false, message: 'No errors recorded' };
		}
		try {
			const data = JSON.parse(fs.readFileSync(errorFile, 'utf8'));
			const isRecent = data.timestamp && Date.now() - data.timestamp < 60_000;
			return {
				hasError: true,
				isRecent,
				error: data.error,
				time: data.time,
				timestamp: data.timestamp,
				details: data.details,
			};
		} catch {
			return { hasError: false, message: 'No recent errors' };
		}
	},
};

const clear_last_error: CommandHandler = {
	name: 'clear_last_error',
	docs: {
		summary: 'Delete _last_error.json for the resolved instance.',
	},
	async handle(ctx) {
		const errorFile = path.join(ctx.instanceFolder, '_last_error.json');
		if (fs.existsSync(errorFile)) {
			fs.unlinkSync(errorFile);
			return { cleared: true, message: 'Error cleared' };
		}
		return { cleared: false, message: 'No error to clear' };
	},
};

const sync_now: CommandHandler = {
	name: 'sync_now',
	noInstance: true,
	docs: {
		summary: 'Flush every pending file in the sync queue immediately.',
	},
	async handle() {
		const state = getSyncState();
		if (state.pendingFiles.length === 0) {
			return { synced: false, message: 'No pending files to sync', count: 0 };
		}
		const files = state.pendingFiles.slice();
		const count = files.length;
		state.processPendingFiles();
		return { synced: true, message: `Synced ${count} file(s) immediately`, count, files };
	},
};

const get_instance_info: CommandHandler = {
	name: 'get_instance_info',
	docs: {
		summary: 'Return the resolved instance name and connection flags.',
	},
	async handle(ctx) {
		const instanceName = path.basename(ctx.instanceFolder);
		const settings = eu.getInstanceSettings(instanceName);
		return {
			instanceName,
			hasSettings: !!(settings && settings.url),
			connected: ctx.isServerRunning() && ctx.hasBrowserClient(),
		};
	},
};

export const connectionCommands: CommandHandler[] = [
	check_connection,
	get_sync_status,
	get_last_error,
	clear_last_error,
	sync_now,
	get_instance_info,
];

// ---------------------------------------------------------------------------
// Sync-state shim. extension.ts owns the pendingFiles queue; it registers an
// accessor so command handlers can observe and flush the queue without
// reaching into that file.
// ---------------------------------------------------------------------------
export interface SyncState {
	pendingFiles: string[];
	isPaused: boolean;
	processPendingFiles(): void;
}

let syncStateProvider: () => SyncState = () => ({
	pendingFiles: [],
	isPaused: false,
	processPendingFiles: () => { /* no-op until host wires it up */ },
});

export function setSyncStateProvider(fn: () => SyncState) {
	syncStateProvider = fn;
}

function getSyncState(): SyncState {
	return syncStateProvider();
}
