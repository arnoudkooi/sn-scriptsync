import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeDeployLink } from '../NowSdkProject';
import { saveBaselineFromPackage } from '../NowSdkPull';
import { makeZip } from './helpers/zip';

test('disconnect invalidates the displayed result; reconnect needs a fresh check before showing success', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-view-test-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.writeFileSync(path.join(root, 'now.config.json'), JSON.stringify({ scope: 'x_app', scopeId: 'a'.repeat(32) }));
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'App', version: '1.0.0' }));
	writeDeployLink(root, { instance: 'dev1', url: 'https://dev1.example' });
	const records = new Map([['record.xml', '<record_update><sys_script><name>Rule</name></sys_script></record_update>']]);
	await saveBaselineFromPackage(root, 'dev1', makeZip([{ name: 'update/record.xml', content: records.get('record.xml')! }]));
	class Emitter {
		listeners = new Set<(value: any) => void>();
		event = (listener: (value: any) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
		fire(value?: any) { for (const listener of this.listeners) listener(value); }
		dispose() { this.listeners.clear(); }
	}
	const noop = () => ({ dispose() {} });
	const view = { visible: true, onDidChangeVisibility: noop, dispose() {} };
	const mock = {
		EventEmitter: Emitter,
		TreeItem: class { constructor(public label: string) {} },
		TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
		ThemeIcon: class { constructor(public id: string) {} },
		ThemeColor: class {},
		window: { createTreeView: () => view, onDidChangeActiveTextEditor: noop },
		workspace: { onDidSaveTextDocument: noop, registerTextDocumentContentProvider: noop, findFiles: async () => [], createFileSystemWatcher: () => ({ onDidCreate: noop, onDidDelete: noop, dispose() {} }) },
		commands: { registerCommand: noop, executeCommand: async () => {} },
		languages: { registerCodeLensProvider: noop },
	};
	const Module = require('module');
	const load = Module._load;
	Module._load = function (name: string, ...args: any[]) { return name === 'vscode' ? mock : load.call(this, name, ...args); };
	const deploy = require('../NowSdkDeploy');
	const { NowSdkTreeViewProvider } = require('../NowSdkTreeView');
	Module._load = load;
	const originalDownload = deploy.downloadInstanceRecords;
	t.after(() => { Module._load = load; deploy.downloadInstanceRecords = originalDownload; });
	const pending: Array<(records: Map<string, string>) => void> = [];
	deploy.downloadInstanceRecords = async () => new Promise((resolve) => pending.push(resolve));
	const event = new Emitter();
	let connected = true;
	const provider = new NowSdkTreeViewProvider(() => ({
		isRunning: () => true, onConnectionChanged: event.event,
		helperCapabilities: () => connected ? { sdkPull: 1 } : null,
		helperProFeatures: () => true,
		getInstanceSettings: () => ({ url: 'https://dev1.example', g_ck: 'test-session' }),
	}));
	provider.register();
	t.after(() => provider.dispose());
	provider.root = root;
	provider.checks.set(`${root}|dev1`, { state: 'done', changes: [], records: new Map(), at: Date.now() });
	let renders = 0;
	provider.onDidChangeTreeData(() => renders++);
	const row = () => provider.getChildren().find((n: any) => /no changes|No changes|Checking dev1/.test(n.label));
	assert.strictEqual(row().label, 'No changes on dev1');
	connected = false;
	event.fire();
	await new Promise(setImmediate);
	assert.ok(renders > 0, 'disconnect redraws the view without editor interaction');
	assert.strictEqual(row().label, 'Last check: no changes on dev1');
	assert.strictEqual(row().iconPath.id, 'history');
	connected = true;
	event.fire();
	await new Promise(setImmediate);
	assert.strictEqual(pending.length, 1, 'reconnect bypasses the recent-result cache');
	assert.strictEqual(row().label, 'Checking dev1 for changes…');
	// A request finishing after another disconnect cannot turn the row green.
	connected = false;
	event.fire();
	pending.shift()!(records);
	await new Promise(setImmediate);
	assert.strictEqual(row().label, 'Last check: no changes on dev1');
	connected = true;
	event.fire();
	await new Promise(setImmediate);
	pending.shift()!(records);
	await new Promise(setImmediate);
	assert.strictEqual(row().label, 'No changes on dev1');
	assert.strictEqual(row().iconPath.id, 'pass');
});
