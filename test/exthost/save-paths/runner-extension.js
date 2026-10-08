// End-to-end check of which saves the real sn-scriptsync pushes.
//
// Launched by `node scripts/test-save-paths.mjs --extension`: the extension
// runs from this repo with SN_SCRIPTSYNC_TEST_PORTS and its own HOME, so its
// bridge never touches 1977/1978 or the user's port files. This runner plays
// the helper tab: it connects to the test browser port and records every push
// the extension sends, with its syncIntent.
//
// Expected: only Save & Sync pushes on save. Save All, document.save() from
// another extension and a rename across files are held in Pending Saves, stay
// held while the auto-sync timer runs, and go out on Sync Now as queue_sync.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.SNU_PROBE_WORKSPACE;
const OUT = process.env.SNU_PROBE_OUT;
const REPO = process.env.SNU_PROBE_REPO;
const BROWSER_PORT = Number(String(process.env.SN_SCRIPTSYNC_TEST_PORTS || '').split(',')[1]);
const wait = ms => new Promise(r => setTimeout(r, ms));
const file = rel => path.join(WORKSPACE, rel);

function socketClass() {
	if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
	return require(path.join(REPO, 'node_modules', 'ws'));
}

async function connectHelper(log) {
	const WS = socketClass();
	for (let i = 0; i < 60; i++) {
		const socket = await new Promise(resolve => {
			const s = new WS(`ws://127.0.0.1:${BROWSER_PORT}`);
			s.onopen = () => resolve(s);
			s.onerror = () => resolve(null);
		});
		if (socket) {
			socket.onmessage = e => {
				let msg;
				try { msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()); } catch { return; }
				if (msg && msg.sys_id && (msg.content !== undefined || msg.fields)) {
					log.push({ name: msg.name, instance: msg.instance && msg.instance.name, syncIntent: msg.syncIntent || null, saveSource: msg.saveSource });
				}
			};
			return socket;
		}
		await wait(500);
	}
	throw new Error(`could not connect to the test bridge on ${BROWSER_PORT}`);
}

async function open(rel, opts = {}) {
	const doc = await vscode.workspace.openTextDocument(file(rel));
	if (opts.show === false) return { doc };
	const editor = await vscode.window.showTextDocument(doc, { preview: false });
	return { doc, editor };
}

async function append(doc, text) {
	const edit = new vscode.WorkspaceEdit();
	edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), text + '\n');
	await vscode.workspace.applyEdit(edit);
}

const names = list => list.map(p => `${p.instance}/${p.name}:${p.syncIntent}`).sort();

exports.run = async function () {
	const report = { scenarios: [] };
	const pushes = [];
	let socket;
	const record = async (id, label, expected, run) => {
		const before = pushes.length;
		let error;
		try { await run(); await wait(2500); } catch (e) { error = String(e && e.message || e); }
		const got = names(pushes.slice(before));
		const want = expected.slice().sort();
		report.scenarios.push({ id, label, expected: want, got, ok: !error && JSON.stringify(got) === JSON.stringify(want), error });
		await vscode.commands.executeCommand('workbench.action.files.saveAll');
		await wait(300);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await wait(300);
	};
	try {
		const ext = vscode.extensions.all.find(e => e.packageJSON && e.packageJSON.name === 'sn-scriptsync');
		if (!ext) throw new Error('sn-scriptsync is not loaded');
		await ext.activate();
		await vscode.commands.executeCommand('extension.snScriptSyncEnable');
		socket = await connectHelper(pushes);
		await wait(1500);

		await record('save_and_sync', 'Ctrl+S (Save & Sync) in the active file', ['inst_a/s1:save_command'], async () => {
			const { doc } = await open('inst_a/global/sys_script/s1.script.js');
			await append(doc, '// typed');
			await vscode.commands.executeCommand('extension.saveAndSync');
		});

		await record('save_and_sync_unchanged', 'Ctrl+S on a file without changes pushes it once', ['inst_a/s2:save_command'], async () => {
			await open('inst_a/global/sys_script/s2.script.js');
			await vscode.commands.executeCommand('extension.saveAndSync');
		});

		await record('save_without_formatting_and_sync', 'Save Without Formatting & Sync', ['inst_a/s3:save_command'], async () => {
			const { doc } = await open('inst_a/global/sys_script/s3.script.js');
			await append(doc, '// typed');
			await vscode.commands.executeCommand('extension.saveWithoutFormattingAndSync');
		});

		await record('plain_save', 'Plain workbench save (rebound key, Vim :w) is held', [], async () => {
			const { doc } = await open('inst_a/global/sys_script/s4.script.js');
			await append(doc, '// typed');
			await vscode.commands.executeCommand('workbench.action.files.save');
		});

		await record('save_all', 'Save All is held', [], async () => {
			const bg = await open('inst_b/global/sys_script/t1.script.js');
			const fg = await open('inst_a/global/sys_script/s1.script.js');
			await append(bg.doc, '// background');
			await append(fg.doc, '// front');
			await vscode.commands.executeCommand('workbench.action.files.saveAll');
		});

		await record('api_save_closed', 'Another extension saves a closed file: held', [], async () => {
			const { doc } = await open('inst_b/global/sys_script/t2.script.js', { show: false });
			await append(doc, '// extension');
			await doc.save();
		});

		await record('refactor_rename', 'Rename across files and instances (F2 path) is held, also with the auto-sync timer on', [], async () => {
			await vscode.workspace.getConfiguration('sn-scriptsync').update('externalChanges.syncDelay', 1, vscode.ConfigurationTarget.Workspace);
			const { doc, editor } = await open('inst_a/global/sys_script_include/a1.script.js');
			const pos = doc.positionAt(doc.getText().indexOf('current'));
			editor.selection = new vscode.Selection(pos, pos);
			let edit;
			for (let i = 0; i < 60; i++) {
				try { edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', doc.uri, pos, 'hrCaseGR'); } catch { edit = undefined; }
				if (edit && edit.entries().length > 1) break;
				await wait(1000);
			}
			if (!edit || edit.entries().length < 2) throw new Error('TypeScript rename provider did not return a cross-file edit');
			await vscode.workspace.applyEdit(edit, { isRefactoring: true });
			await wait(2500); // the 1 second timer would have fired
		});

		await record('sync_now', 'Sync Now pushes everything held, labeled queue_sync', [
			'inst_a/s4:queue_sync', 'inst_a/s1:queue_sync', 'inst_b/t1:queue_sync', 'inst_b/t2:queue_sync',
			'inst_a/a1:queue_sync', 'inst_a/a2:queue_sync', 'inst_b/b1:queue_sync', 'inst_b/b2:queue_sync',
		], async () => {
			await vscode.commands.executeCommand('extension.syncNow');
		});

		// A build tool writing synced files on disk, outside VS Code.
		await record('disk_write_closed', 'A build writes a closed file on disk (Sync Delay 0): held', [], async () => {
			await vscode.workspace.getConfiguration('sn-scriptsync').update('externalChanges.syncDelay', 0, vscode.ConfigurationTarget.Workspace);
			await wait(500);
			fs.appendFileSync(file('inst_a/global/sys_script/s2.script.js'), '// built\n');
		});

		await record('disk_write_open', 'A build writes a file open in the editor (Sync Delay 0): held', [], async () => {
			await open('inst_a/global/sys_script/s3.script.js');
			await wait(500);
			fs.appendFileSync(file('inst_a/global/sys_script/s3.script.js'), '// built\n');
		});

		await record('disk_write_auto_sync', 'A build writes a file with Sync Delay 1: auto-synced, labeled queue_auto_sync', [
			'inst_a/s2:queue_auto_sync', 'inst_a/s3:queue_auto_sync', 'inst_b/t1:queue_auto_sync',
		], async () => {
			await vscode.workspace.getConfiguration('sn-scriptsync').update('externalChanges.syncDelay', 1, vscode.ConfigurationTarget.Workspace);
			await wait(500);
			fs.appendFileSync(file('inst_b/global/sys_script/t1.script.js'), '// built\n');
			await wait(2500);
		});
	} catch (e) {
		report.error = String(e && e.stack || e);
	} finally {
		try { socket && socket.close(); } catch { }
		try { await vscode.commands.executeCommand('extension.snScriptSyncDisable'); } catch { }
		fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
	}
};
