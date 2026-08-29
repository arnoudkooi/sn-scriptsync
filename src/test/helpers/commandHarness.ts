/**
 * A test harness for Agent API command handlers.
 *
 * Every bug that reached a human this session lived in a command's wiring, not
 * in the pure modules the other suites cover: `create_record` injecting a
 * `sys_scope` column that plain data rows do not have, and the payload a
 * create actually puts on the wire. Those call sites had no coverage at all
 * because they sit behind an `import * as vscode`, which cannot be loaded
 * outside an extension host.
 *
 * The coupling turns out to be tiny — a handful of `vscode.workspace` reads —
 * so rather than extract yet more logic into testable modules (the pattern that
 * left the wiring untested in the first place), this stubs the module and calls
 * the real handlers with a fake AgentContext.
 *
 * CommonJS only: the extension compiles to CJS, so seeding require.cache is
 * enough to satisfy `require('vscode')` before any command module is loaded.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BrowserMessage {
	action?: string;
	[key: string]: any;
}

export interface CommandHarness {
	/** Root of the throwaway workspace. */
	workspaceRoot: string;
	/** Absolute path of the instance folder handlers receive. */
	instanceFolder: string;
	/** Everything the handler pushed to the browser, in order. */
	sent: BrowserMessage[];
	/** Queue a reply for the next browser round-trip. */
	reply(response: any): void;
	/** Queue a rejection for the next browser round-trip. */
	replyWithError(error: any): void;
	/** Build a context for one request. */
	context(overrides?: Partial<Record<string, any>>): any;
	cleanup(): void;
}

/**
 * Install a minimal `vscode` stub. Must run before any module that imports it.
 * Returns the stub so a test can adjust configuration values.
 */
export function stubVscode(workspaceRoot: string): any {
	const configValues: Record<string, any> = { path: path.basename(workspaceRoot) };

	const stub = {
		workspace: {
			workspaceFolders: [{ uri: { fsPath: workspaceRoot }, name: path.basename(workspaceRoot), index: 0 }],
			rootPath: workspaceRoot,
			getConfiguration: () => ({
				get: (key: string, fallback?: any) => (key in configValues ? configValues[key] : fallback),
			}),
			openTextDocument: async () => ({}),
			onDidChangeConfiguration: () => ({ dispose() { /* noop */ } }),
			onDidChangeWorkspaceFolders: () => ({ dispose() { /* noop */ } }),
		},
		window: {
			showTextDocument: async () => ({}),
			showWarningMessage: async () => undefined,
			showInformationMessage: async () => undefined,
			showErrorMessage: async () => undefined,
		},
		commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose() { /* noop */ } }) },
		Uri: { file: (p: string) => ({ fsPath: p }) },
		configValues,
	};

	const id = 'vscode';
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Module = require('module');
	if (!Module._resolveFilename.__snPatched) {
		const original = Module._resolveFilename;
		const patched = function (request: string, ...args: any[]) {
			if (request === 'vscode') return id;
			return original.call(this, request, ...args);
		};
		patched.__snPatched = true;
		Module._resolveFilename = patched;
	}
	require.cache[id] = { id, filename: id, loaded: true, exports: stub } as any;
	return stub;
}

/**
 * Create a throwaway workspace with one instance folder and settings, then a
 * context factory for calling handlers against it.
 */
export function createHarness(instanceName = 'testinst'): CommandHarness {
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-cmd-'));
	const instanceFolder = path.join(workspaceRoot, instanceName);
	fs.mkdirSync(instanceFolder, { recursive: true });
	fs.writeFileSync(
		path.join(instanceFolder, '_settings.json'),
		JSON.stringify({ name: instanceName, url: `https://${instanceName}.service-now.com` })
	);

	stubVscode(workspaceRoot);

	const sent: BrowserMessage[] = [];
	const replies: Array<{ ok: boolean; value: any }> = [];

	const harness: CommandHarness = {
		workspaceRoot,
		instanceFolder,
		sent,
		reply(response: any) {
			replies.push({ ok: true, value: response });
		},
		replyWithError(error: any) {
			replies.push({ ok: false, value: error });
		},
		context(overrides: Partial<Record<string, any>> = {}) {
			return {
				request: { id: 'test_1', command: 'test', params: {} },
				instanceFolder,
				workspaceRoot,
				sendToBrowser: (payload: any) => { sent.push(payload); },
				waitForBrowserResponse: async () => {
					const next = replies.shift();
					if (!next) throw new Error('No queued browser reply — the test must queue one with reply()');
					if (!next.ok) throw next.value;
					return next.value;
				},
				log: () => { /* quiet */ },
				hasBrowserClient: () => true,
				isServerRunning: () => true,
				reviewWritesEnabled: () => false,
				getHelperBuildInfo: () => null,
				getInstanceGates: () => null,
				stageWrite: () => { throw new Error('stageWrite not expected in this test'); },
				...overrides,
			};
		},
		cleanup() {
			try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best effort */ }
		},
	};

	return harness;
}
