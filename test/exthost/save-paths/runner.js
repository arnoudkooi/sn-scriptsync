// Records which save events VS Code raises for each way a ScriptSync file can be
// saved, and what the current ScriptSync rule (src/extension.ts, the
// onWillSaveTextDocument / onDidSaveTextDocument pair) would make of them.
//
// Runs inside a real VS Code extension host, launched by
// scripts/test-save-paths.mjs with its own user data and extensions folders.
// It never opens port 1978 and does not load sn-scriptsync itself: it observes
// the editor, applies the same classification, and writes a JSON report.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.SNU_PROBE_WORKSPACE;
const OUT = process.env.SNU_PROBE_OUT;
const wait = ms => new Promise(r => setTimeout(r, ms));
const rel = uri => path.relative(WORKSPACE, uri.fsPath);
const REASONS = { 1: 'Manual', 2: 'AfterDelay', 3: 'FocusOut' };

function editorState(doc) {
	const key = doc.uri.toString();
	const active = vscode.window.activeTextEditor?.document.uri.toString() === key;
	const visible = vscode.window.visibleTextEditors.some(e => e.document.uri.toString() === key);
	const tab = vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input?.uri?.toString() === key));
	return { active, visible, tab };
}

// Same bookkeeping as the extension: a did-save counts as manual when the
// will-save reason was Manual, or when no will-save fired at all (#119).
function createRecorder() {
	let events = [];
	const manual = new Map();
	const seen = new Map();
	const subs = [
		vscode.workspace.onWillSaveTextDocument(e => {
			const key = e.document.uri.toString();
			seen.set(key, true);
			if (e.reason === vscode.TextDocumentSaveReason.Manual) manual.set(key, true);
			events.push({ type: 'willSave', file: rel(e.document.uri), reason: REASONS[e.reason] || e.reason, ...editorState(e.document) });
		}),
		vscode.workspace.onDidSaveTextDocument(doc => {
			const key = doc.uri.toString();
			const wasManual = manual.get(key);
			const wasSeen = seen.get(key);
			manual.delete(key);
			seen.delete(key);
			events.push({ type: 'didSave', file: rel(doc.uri), willSaveFired: !!wasSeen, currentRulePushes: !!(wasManual || !wasSeen), ...editorState(doc) });
		})
	];
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(WORKSPACE, '**/*.js'));
	watcher.onDidChange(uri => events.push({ type: 'watcherChange', file: rel(uri) }));
	subs.push(watcher);
	return {
		take() { const out = events; events = []; return out; },
		dispose() { subs.forEach(s => s.dispose()); }
	};
}

async function open(file, opts = {}) {
	const doc = await vscode.workspace.openTextDocument(path.join(WORKSPACE, file));
	if (opts.show === false) return { doc };
	const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: !!opts.background });
	return { doc, editor };
}

async function appendLine(doc, text) {
	const edit = new vscode.WorkspaceEdit();
	edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), text + '\n');
	await vscode.workspace.applyEdit(edit);
}

async function settle() { await wait(1500); }

async function resetEditors() {
	await vscode.commands.executeCommand('workbench.action.files.saveAll');
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	await wait(300);
}

const scenarios = [
	{
		id: 'ctrl_s_active',
		label: 'Ctrl+S in the active editor',
		async run() {
			const { doc } = await open('inst_a/sys_script/s1.js');
			await appendLine(doc, '// typed');
			await vscode.commands.executeCommand('workbench.action.files.save');
		}
	},
	{
		id: 'save_without_formatting',
		label: 'Save Without Formatting',
		async run() {
			const { doc } = await open('inst_a/sys_script/s2.js');
			await appendLine(doc, '// typed');
			await vscode.commands.executeCommand('workbench.action.files.saveWithoutFormatting');
		}
	},
	{
		id: 'api_save_background',
		label: 'Extension calls document.save() on a background tab',
		async run() {
			const { doc } = await open('inst_a/sys_script/s3.js');
			await open('inst_a/sys_script/s1.js');
			await appendLine(doc, '// from an extension');
			await doc.save();
		}
	},
	{
		id: 'api_save_closed',
		label: 'Extension edits and saves a file that is not open in any editor',
		async run() {
			const { doc } = await open('inst_b/sys_script/t1.js', { show: false });
			await appendLine(doc, '// from an extension');
			await doc.save();
		}
	},
	{
		id: 'save_all',
		label: 'Save All with one active and one background dirty file',
		async run() {
			const bg = await open('inst_a/sys_script/s4.js');
			const fg = await open('inst_a/sys_script/s1.js');
			await appendLine(bg.doc, '// dirty in background');
			await appendLine(fg.doc, '// dirty in front');
			await vscode.commands.executeCommand('workbench.action.files.saveAll');
		}
	},
	{
		id: 'disk_write',
		label: 'Another program writes the file on disk',
		async run() {
			fs.appendFileSync(path.join(WORKSPACE, 'inst_b/sys_script/t2.js'), '// written on disk\n');
		}
	},
	{
		id: 'refactor_rename',
		label: 'Rename symbol (F2 code path) with files.refactoring.autoSave on',
		async run(note) {
			await open('inst_a/sys_script_include/a2.js', { background: false });
			const { doc, editor } = await open('inst_a/sys_script_include/a1.js');
			const pos = doc.positionAt(doc.getText().indexOf('current'));
			editor.selection = new vscode.Selection(pos, pos);
			let edit;
			for (let i = 0; i < 60; i++) {
				try { edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', doc.uri, pos, 'hrCaseGR'); } catch { edit = undefined; }
				if (edit && edit.entries().length > 1) break;
				await wait(1000);
			}
			if (!edit || edit.entries().length < 2) throw new Error('TypeScript rename provider did not return a cross-file edit');
			note(`rename edit touches ${edit.entries().length} files`);
			// The rename widget applies its result with respectAutoSaveConfig,
			// which is what isRefactoring maps to for extension-applied edits.
			await vscode.workspace.applyEdit(edit, { isRefactoring: true });
		}
	}
];

exports.run = async function () {
	const report = { vscodeVersion: vscode.version, settings: {
		refactoringAutoSave: vscode.workspace.getConfiguration('files').get('refactoring.autoSave'),
		autoSave: vscode.workspace.getConfiguration('files').get('autoSave')
	}, scenarios: [] };
	const recorder = createRecorder();
	try {
		for (const s of scenarios) {
			const notes = [];
			let error;
			try {
				await s.run(n => notes.push(n));
				await settle();
			} catch (e) {
				error = String(e && e.message || e);
			}
			report.scenarios.push({ id: s.id, label: s.label, notes, error, events: recorder.take() });
			await resetEditors();
			recorder.take();
		}
	} finally {
		recorder.dispose();
		fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
	}
};
