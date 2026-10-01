// "NOW SDK App" view in the ScriptSync sidebar. Shown only when the workspace
// holds a NOW SDK project; follows the project of the active editor. It answers
// the questions a developer would otherwise go and check: which instance, did
// someone change the app there, what did I edit since the last deploy, what is
// in the app. Each answer carries its action (deploy, pull, open).

import * as path from 'path';
import * as vscode from 'vscode';
import {
	NOW_CONFIG_FILE, NowSdkProject, assertSupportedSdk, findNowSdkProjectRoot, readDeployLink, readNowSdkProject,
} from './NowSdkProject';
import {
	InstanceChange, changedFieldNames, dismissInstanceChange, fieldsBuiltDifferently, hasBaseline, instanceChangesFromRecords, readBaselineRecord, readBuiltRecord, readRecordFields, readSyncMarkers, recordForReading,
} from './NowSdkPull';
import { isChoiceSet } from './NowSdkChoices';
import { loadTypeScript, planAccept } from './NowSdkAccept';
import { SourceLocation, SourceRecord, indexSourceDefinitions, readKeysFile, recordAtOffset, recordFileName, recordsInSource } from './NowSdkCursor';
import { AppRecordGroup, filesEditedSince, readAppContents, relativeTime } from './NowSdkInsight';
import { runNowSdk } from './NowSdkBuild';
import {
	NowSdkDeployDeps, changeNowSdkInstance, deployNowSdkApp, downloadInstanceRecords, isSessionProblem, onNowSdkProjectChanged, pullNowSdkApp, showSessionProblem,
} from './NowSdkDeploy';

const DOCS_URL = 'https://snutils.com/docs/guide/scriptsync/now-sdk-deploy';
const FEEDBACK_URL = 'https://snutils.com/contact?utm_source=scriptsync&utm_medium=referral&utm_campaign=beta-feedback&utm_content=sdk-view';
const CHECK_STALE_MS = 10 * 60 * 1000;
/** A download this recent is reused by the view instead of asking the instance again. */
const RECENT_DOWNLOAD_MS = 60 * 1000;

type InstanceCheck =
	| { state: 'checking' }
	| { state: 'done'; changes: InstanceChange[]; records: Map<string, string>; at: number; stale?: boolean }
	| { state: 'error'; message: string; at: number; session?: boolean };

class Node extends vscode.TreeItem {
	constructor(
		label: string,
		opts: {
			icon?: string;
			color?: string;
			description?: string;
			tooltip?: string | vscode.MarkdownString;
			command?: vscode.Command;
			contextValue?: string;
			children?: () => Node[];
			expanded?: boolean;
			resourceUri?: vscode.Uri;
			change?: InstanceChange;
			url?: string;
		} = {},
	) {
		super(label, opts.children ? (opts.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
		if (opts.icon) this.iconPath = new vscode.ThemeIcon(opts.icon, opts.color ? new vscode.ThemeColor(opts.color) : undefined);
		this.description = opts.description;
		this.tooltip = opts.tooltip;
		this.command = opts.command;
		this.contextValue = opts.contextValue;
		this.children = opts.children;
		if (opts.resourceUri) this.resourceUri = opts.resourceUri;
		this.change = opts.change;
		this.url = opts.url;
	}
	children?: () => Node[];
	change?: InstanceChange;
	/** The record on the instance, for the inline "open on instance" button. */
	url?: string;
}

export class NowSdkTreeViewProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	private view?: vscode.TreeView<Node>;
	private root: string | null = null;
	/** Instance check results per project root + instance. */
	private checks = new Map<string, InstanceCheck>();
	private disposables: vscode.Disposable[] = [];
	private refreshTimer?: NodeJS.Timeout;
	private connectionRevision = 0;
	private readonly lensEmitter = new vscode.EventEmitter<void>();
	/** sys_id -> where the record is defined, built when "In the app" is expanded. */
	private sourceIndex?: { root: string; map: Map<string, SourceLocation> };

	constructor(private readonly deps: () => NowSdkDeployDeps) {}

	register(): vscode.Disposable[] {
		this.view = vscode.window.createTreeView('nowSdkTreeView', { treeDataProvider: this, showCollapseAll: false });
		const run = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
		this.disposables.push(
			this.view,
			this.view.onDidChangeVisibility((e) => {
				if (e.visible) this.refresh(true);
			}),
			vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
			onNowSdkProjectChanged((root) => {
				if (root === this.root) {
					this.checks.clear();
					this.sourceIndex = undefined;
					this.refresh(true);
				}
			}),
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (this.root && doc.uri.fsPath.startsWith(this.root + path.sep)) {
					this.sourceIndex = undefined;
					this.refreshSoon();
				}
			}),
			run('sn-scriptsync.nowSdkView.refresh', () => {
				this.checks.clear();
				this.refresh(true, true);
			}),
			run('sn-scriptsync.nowSdkView.deploy', () => deployNowSdkApp(this.deps(), this.configUri())),
			run('sn-scriptsync.nowSdkView.pull', () => pullNowSdkApp(this.deps(), this.configUri())),
			run('sn-scriptsync.nowSdkView.changeInstance', () => changeNowSdkInstance(this.deps(), this.configUri())),
			run('sn-scriptsync.nowSdkView.check', () => this.checkInstance(true)),
			run('sn-scriptsync.nowSdkView.build', () => this.build()),
			run('sn-scriptsync.nowSdkView.openUrl', (url: string) => vscode.env.openExternal(vscode.Uri.parse(url))),
			run('sn-scriptsync.nowSdkView.openOnInstance', (node: Node) => node?.url && vscode.env.openExternal(vscode.Uri.parse(node.url))),
			run('sn-scriptsync.nowSdkView.diff', (node: Node) => this.showDiff(node)),
			run('sn-scriptsync.nowSdkView.openSource', async (uri: vscode.Uri, offset: number) => {
				const doc = await vscode.workspace.openTextDocument(uri);
				const at = doc.positionAt(offset || 0);
				await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at), preview: true });
			}),
			run('sn-scriptsync.nowSdkView.openRecord', (node: Node) => this.openRecord(node)),
			run('sn-scriptsync.nowSdkView.dismiss', (node: Node) => this.dismiss(node)),
			run('sn-scriptsync.nowSdkView.accept', (node: Node) => this.accept(node)),
			vscode.workspace.registerTextDocumentContentProvider('snu-nowsdk', { provideTextDocumentContent: (uri) => this.docs.get(uri.toString()) ?? '' }),
			// From the Fluent source: the record of the definition at the cursor.
			run('sn-scriptsync.nowSdkEditor.open', (uri?: vscode.Uri, offset?: number) => this.fromSource('open', uri, offset)),
			run('sn-scriptsync.nowSdkEditor.compare', (uri?: vscode.Uri, offset?: number) => this.fromSource('compare', uri, offset)),
			run('sn-scriptsync.nowSdkEditor.accept', (uri?: vscode.Uri, offset?: number) => this.fromSource('accept', uri, offset)),
			run('sn-scriptsync.nowSdkEditor.dismiss', (uri?: vscode.Uri, offset?: number) => this.fromSource('dismiss', uri, offset)),
			vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**/*.now.ts' }, {
				onDidChangeCodeLenses: this.lensEmitter.event,
				provideCodeLenses: (doc) => this.codeLenses(doc),
			}),
			this.lensEmitter,
			this.onDidChangeTreeData(() => {
				this.lensEmitter.fire();
				this.updateEditorContext();
			}),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateEditorContext()),
		);
		const connectionChanged = this.deps().onConnectionChanged;
		if (connectionChanged) this.disposables.push(connectionChanged(() => {
			this.connectionRevision++;
			for (const check of this.checks.values()) if (check.state === 'done') check.stale = true;
			this.emitter.fire(undefined);
			// Let requests from the old session finish before checking again.
			// Their results remain cached until a check on this session succeeds.
			void Promise.allSettled([...this.inflight.values()]).then(() => {
				if (this.view?.visible) return this.checkInstance(true, true);
			});
		}));
		// Show the view only in workspaces that hold a NOW SDK project.
		const watcher = vscode.workspace.createFileSystemWatcher(`**/${NOW_CONFIG_FILE}`);
		watcher.onDidCreate(() => this.updateVisibility());
		watcher.onDidDelete(() => this.updateVisibility());
		this.disposables.push(watcher);
		this.updateVisibility();
		return [this];
	}

	dispose() {
		this.disposables.forEach((d) => d.dispose());
		this.emitter.dispose();
	}

	private async updateVisibility() {
		const found = await vscode.workspace.findFiles(`**/${NOW_CONFIG_FILE}`, '{**/node_modules/**,**/.snu/**}', 1);
		vscode.commands.executeCommand('setContext', 'sn-scriptsync.hasNowSdkProject', found.length > 0);
		if (found.length > 0 && !this.root) this.refresh();
	}

	private configUri(): vscode.Uri | undefined {
		return this.root ? vscode.Uri.file(path.join(this.root, NOW_CONFIG_FILE)) : undefined;
	}

	/** Follow the active editor's project; keep the last one while other files are open. */
	private async resolveRoot(): Promise<string | null> {
		const file = vscode.window.activeTextEditor?.document.uri;
		if (file?.scheme === 'file') {
			const parts = file.fsPath.split(path.sep);
			if (!parts.includes('.snu') && !parts.includes('node_modules')) {
				const root = findNowSdkProjectRoot(file.fsPath);
				if (root) return root;
			}
		}
		if (this.root) return this.root;
		const found = await vscode.workspace.findFiles(`**/${NOW_CONFIG_FILE}`, '{**/node_modules/**,**/.snu/**}', 1);
		return found.length ? path.dirname(found[0].fsPath) : null;
	}

	/** Read-only documents for the diff views, keyed by URI. */
	private docs = new Map<string, string>();

	private changeContext(node: Node) {
		const change = node?.change;
		const link = this.root ? readDeployLink(this.root) : null;
		if (!change?.file || !this.root || !link) return null;
		const check = this.checks.get(this.checkKey(link.instance));
		const records = check?.state === 'done' ? check.records : undefined;
		return { change, root: this.root, instance: link.instance, url: link.url, records };
	}

	/** Last sync ↔ instance now, field by field. */
	private async showDiff(node: Node) {
		const ctx = this.changeContext(node);
		if (!ctx) return;
		const before = recordForReading(readBaselineRecord(ctx.root, ctx.instance, ctx.change.file!));
		const after = recordForReading(ctx.records?.get(ctx.change.file!));
		const stamp = Date.now();
		const left = vscode.Uri.parse(`snu-nowsdk:/${encodeURIComponent(ctx.change.label)} (last sync)?${stamp}`);
		const right = vscode.Uri.parse(`snu-nowsdk:/${encodeURIComponent(ctx.change.label)} (${ctx.instance})?${stamp}`);
		this.docs.set(left.toString(), before || '(not there after the last sync)');
		this.docs.set(right.toString(), after || `(deleted on ${ctx.instance})`);
		await vscode.commands.executeCommand('vscode.diff', left, right, `${ctx.change.label}: last sync ↔ ${ctx.instance}`, { preview: true });
	}

	private openRecord(node: Node) {
		const ctx = this.changeContext(node);
		if (!ctx) return;
		const m = /^([a-z0-9_]+?)_([0-9a-f]{32})\.xml$/.exec(ctx.change.file!);
		const settings = this.deps().getInstanceSettings(ctx.instance);
		const base = (settings?.url || ctx.url || '').replace(/\/$/, '');
		const xml = ctx.records?.get(ctx.change.file!) || readBaselineRecord(ctx.root, ctx.instance, ctx.change.file!);
		if (base && xml && isChoiceSet(xml)) {
			const fields = readRecordFields(xml);
			const query = encodeURIComponent(`name=${fields.get('name')}^element=${fields.get('element')}`);
			vscode.env.openExternal(vscode.Uri.parse(`${base}/sys_choice_list.do?sysparm_query=${query}`));
			return;
		}
		if (m && base) vscode.env.openExternal(vscode.Uri.parse(`${base}/${m[1]}.do?sys_id=${m[2]}`));
	}

	/** Bring the instance change into the project, whatever kind of record it is. */
	private async accept(node: Node) {
		try {
			await this.acceptChange(node);
		} catch (e: any) {
			vscode.window.showErrorMessage(`Accept failed: ${e?.message || e}`);
		}
	}

	private async acceptChange(node: Node) {
		const ctx = this.changeContext(node);
		if (!ctx) {
			vscode.window.showWarningMessage('This change is not loaded any more. Refresh the NOW SDK App view (↻) and try again.');
			return;
		}
		if (!ctx.records) {
			vscode.window.showWarningMessage(`The instance records are not loaded yet. Refresh the NOW SDK App view (↻) to check ${ctx.instance}, then try again.`);
			return;
		}
		let project: NowSdkProject;
		try {
			project = readNowSdkProject(ctx.root);
		} catch {
			return;
		}
		const file = ctx.change.file!;
		const instanceXml = ctx.records?.get(file);
		// The build shows which fields the Fluent API carries; build once if there is none.
		if (!readBuiltRecord(project.appOutputDir, file) && ctx.change.status !== 'new') {
			await vscode.window.withProgress({ location: { viewId: 'nowSdkTreeView' }, title: 'Building' }, async () => {
				try { await runNowSdk(ctx.root, ['build']); } catch {}
			});
		}
		// Plan against what the editor shows, saved or not, and apply only if
		// none of those documents changed in the meantime.
		const openDocs = new Map<string, vscode.TextDocument>();
		for (const doc of vscode.workspace.textDocuments) {
			if (doc.uri.scheme !== 'file') continue;
			const rel = path.relative(ctx.root, doc.uri.fsPath);
			if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
			openDocs.set(rel.split(path.sep).join('/'), doc);
		}
		const versions = new Map([...openDocs].map(([f, d]) => [f, d.version]));
		const openFiles = new Map([...openDocs].map(([f, d]) => [f, d.getText()]));
		const plan = planAccept(ctx.root, ctx.change, readBaselineRecord(ctx.root, ctx.instance, file), instanceXml, readBuiltRecord(project.appOutputDir, file), { openFiles });

		const edit = new vscode.WorkspaceEdit();
		const targets: Array<{ doc: vscode.TextDocument; wasDirty: boolean }> = [];
		for (const e of plan.edits) {
			const doc = openDocs.get(e.file) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ctx.root, e.file)));
			targets.push({ doc, wasDirty: doc.isDirty });
		}
		const moved = plan.edits.filter((e) => versions.has(e.file) && openDocs.get(e.file)!.version !== versions.get(e.file));
		if (moved.length) {
			vscode.window.showWarningMessage(`${moved.map((e) => e.file).join(', ')} changed while accepting. Nothing was changed; try Accept again.`);
			return;
		}
		plan.edits.forEach((e, i) => {
			const doc = targets[i].doc;
			edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), e.content);
		});
		// A document with unsaved work gets the edit but stays unsaved: saving
		// it is the user's call.
		const toSave = targets.filter((t) => !t.wasDirty).map((t) => t.doc);
		const unsaved = targets.filter((t) => t.wasDirty).map((t) => path.relative(ctx.root, t.doc.uri.fsPath));
		if (plan.edits.length && (!(await vscode.workspace.applyEdit(edit)) || !(await Promise.all(toSave.map((d) => d.save()))).every(Boolean))) {
			vscode.window.showErrorMessage(`Could not update ${plan.edits.map((e) => e.file).join(', ')}.`);
			return;
		}

		// Beta: an edit to source is only trusted once a build produces the
		// instance version; until then the change stays listed.
		let unverified: string[] = [];
		let verifyError = '';
		if (plan.edited.length && !plan.pullFields.length && !unsaved.length && instanceXml) {
			await vscode.window.withProgress({ location: { viewId: 'nowSdkTreeView' }, title: 'Building to check the accepted change' }, async () => {
				try {
					await runNowSdk(ctx.root, ['build']);
					unverified = fieldsBuiltDifferently(readBuiltRecord(project.appOutputDir, file), instanceXml, plan.edited);
				} catch (e: any) {
					verifyError = e?.message || String(e);
				}
			});
		}
		const verified = plan.edited.length > 0 && !unsaved.length && !verifyError && unverified.length === 0;

		if (plan.pullFields.length) {
			await pullNowSdkApp(this.deps(), this.configUri());
		} else if (plan.unresolved.length === 0 && (verified || plan.edits.length === 0)) {
			// Everything is in the source now: stop reporting the change.
			dismissInstanceChange(ctx.root, ctx.instance, file, instanceXml);
			const check = this.checks.get(this.checkKey(ctx.instance));
			if (check?.state === 'done') this.checks.set(this.checkKey(ctx.instance), { ...check, changes: instanceChangesFromRecords(ctx.root, ctx.instance, check.records) });
			this.emitter.fire(undefined);
		}

		const parts: string[] = [];
		if (plan.edits.length) parts.push(`Accepted into ${plan.edits.map((e) => `${e.file} (${e.what.split(': ').pop()})`).join(', ')}.`);
		if (plan.pullFields.length) parts.push(`Pulled ${plan.pullFields.join(', ')}.`);
		if (plan.unresolved.length) parts.push(`Could not accept ${plan.unresolved.map((u) => `${u.field}: ${u.why}`).join('; ')}.`);
		if (unsaved.length) parts.push(`${unsaved.join(', ')} had unsaved changes, so the edit is not saved yet: review and save it. The change stays listed until you deploy.`);
		if (verifyError) parts.push(`The build to check the edit failed (${verifyError}), so the change stays listed.`);
		if (unverified.length) parts.push(`Check the edit: the build does not produce the instance version of ${unverified.join(', ')} yet, so the change stays listed.`);
		if (!parts.length) parts.push('Nothing to accept: the instance version matches the last sync.');
		const message = `${ctx.change.label}: ${parts.join(' ')}${verified ? ' Your next deploy will preserve the accepted change.' : ''}`;
		const buttons = plan.edits.length ? ['Open', 'Show changes'] : ['Show what changed'];
		const show = plan.unresolved.length || unsaved.length || verifyError || unverified.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
		const choice = await show(message, ...buttons);
		if (choice === 'Open' && plan.edits[0]) vscode.window.showTextDocument(vscode.Uri.file(path.join(ctx.root, plan.edits[0].file)));
		if (choice === 'Show changes') vscode.commands.executeCommand('workbench.view.scm');
		if (choice === 'Show what changed') this.showDiff(node);
	}

	/** Accept that the next deploy overwrites this instance change. */
	private async dismiss(node: Node) {
		const ctx = this.changeContext(node);
		if (!ctx) return;
		const choice = await vscode.window.showWarningMessage(
			`Keep your source version of ${ctx.change.label}? This acknowledges the change on ${ctx.instance}. The next deploy applies your source version to records included in the package.`,
			{ modal: true }, 'Keep local version',
		);
		if (choice !== 'Keep local version') return;
		dismissInstanceChange(ctx.root, ctx.instance, ctx.change.file!, ctx.records?.get(ctx.change.file!));
		const check = this.checks.get(this.checkKey(ctx.instance));
		if (check?.state === 'done') {
			this.checks.set(this.checkKey(ctx.instance), { ...check, changes: instanceChangesFromRecords(ctx.root, ctx.instance, check.records) });
		}
		this.emitter.fire(undefined);
	}

	/** Where a record of the app is defined in the source, if found. */
	private definitionOf(root: string, sysId: string): SourceLocation | undefined {
		if (this.sourceIndex?.root !== root) {
			const ts = loadTypeScript(root);
			let map = new Map<string, SourceLocation>();
			try {
				if (ts) map = indexSourceDefinitions(ts, root);
			} catch {}
			this.sourceIndex = { root, map };
		}
		return this.sourceIndex.map.get(sysId);
	}

	/** The instance changes of the current check, when there is one. */
	private currentChanges(root: string): { instance: string; changes: InstanceChange[]; records: Map<string, string> } | null {
		if (root !== this.root) return null;
		const link = readDeployLink(root);
		const check = link ? this.checks.get(this.checkKey(link.instance)) : undefined;
		return link && check?.state === 'done' ? { instance: link.instance, changes: check.changes, records: check.records } : null;
	}

	private sourceRecords(root: string, doc: vscode.TextDocument): SourceRecord[] | null {
		const ts = loadTypeScript(root);
		if (!ts) return null;
		try {
			return recordsInSource(ts, doc.fileName, doc.getText(), readKeysFile(root));
		} catch {
			return [];
		}
	}

	/** Whether the active Fluent file defines a record that changed on the instance (for the editor menu). */
	private updateEditorContext() {
		const doc = vscode.window.activeTextEditor?.document;
		let has = false;
		if (doc?.uri.scheme === 'file' && doc.fileName.endsWith('.now.ts') && this.root) {
			const current = this.currentChanges(this.root);
			if (current?.changes.length && findNowSdkProjectRoot(doc.uri.fsPath) === this.root) {
				const files = new Set(current.changes.map((c) => c.file));
				has = (this.sourceRecords(this.root, doc) || []).some((r) => files.has(recordFileName(r)));
			}
		}
		vscode.commands.executeCommand('setContext', 'sn-scriptsync.nowSdkFileHasChanges', has);
	}

	/** Above each definition that changed on the instance: what changed, Accept, Keep local version. */
	private codeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		const root = findNowSdkProjectRoot(doc.uri.fsPath);
		const current = root ? this.currentChanges(root) : null;
		if (!root || !current?.changes.length) return [];
		const byFile = new Map(current.changes.map((c) => [c.file, c]));
		const lenses: vscode.CodeLens[] = [];
		for (const r of this.sourceRecords(root, doc) || []) {
			const change = byFile.get(recordFileName(r));
			if (!change) continue;
			const range = new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.start));
			const args = [doc.uri, r.start];
			const base = readBaselineRecord(root, current.instance, change.file!);
			const now = current.records.get(change.file!);
			const what = change.status === 'removed' ? 'deleted' : change.status === 'new' ? 'new' : base && now ? changedFieldNames(base, now).join(', ') : '';
			lenses.push(
				new vscode.CodeLens(range, { title: `$(warning) Changed on ${current.instance}${what ? `: ${what}` : ''}`, tooltip: 'Compare the last sync with the instance', command: 'sn-scriptsync.nowSdkEditor.compare', arguments: args }),
				new vscode.CodeLens(range, { title: 'Accept', tooltip: 'Bring the instance change into your source (beta)', command: 'sn-scriptsync.nowSdkEditor.accept', arguments: args }),
				new vscode.CodeLens(range, { title: 'Keep local version', tooltip: 'Keep your source version; the next deploy overwrites the instance change', command: 'sn-scriptsync.nowSdkEditor.dismiss', arguments: args }),
			);
		}
		return lenses;
	}

	/** Open, compare, accept or dismiss the record of the definition at the cursor. */
	private async fromSource(action: 'open' | 'compare' | 'accept' | 'dismiss', uri?: vscode.Uri, offset?: number) {
		const editor = vscode.window.activeTextEditor;
		const target = uri instanceof vscode.Uri ? uri : editor?.document.uri;
		if (!target || target.scheme !== 'file') return;
		const root = findNowSdkProjectRoot(target.fsPath);
		if (!root) return;
		const doc = await vscode.workspace.openTextDocument(target);
		const at = typeof offset === 'number' ? offset
			: editor && editor.document.uri.toString() === target.toString() ? doc.offsetAt(editor.selection.active) : 0;
		const records = this.sourceRecords(root, doc);
		if (!records) {
			vscode.window.showWarningMessage('The TypeScript compiler was not found in the project. Run npm install and try again.');
			return;
		}
		const record = recordAtOffset(records, at);
		if (!record) {
			vscode.window.showInformationMessage('Place the cursor inside a Fluent definition, such as Table({...}) or BusinessRule({...}). A new definition gets its record ID at the next build.');
			return;
		}
		if (this.root !== root) {
			this.root = root;
			this.emitter.fire(undefined);
		}
		const link = readDeployLink(root);
		if (!link) {
			const choice = await vscode.window.showInformationMessage('Choose the instance this app deploys to first.', 'Choose instance');
			if (choice) await changeNowSdkInstance(this.deps(), vscode.Uri.file(path.join(root, NOW_CONFIG_FILE)));
			return;
		}
		const settings = this.deps().getInstanceSettings(link.instance);
		const base = (settings?.url || link.url || '').replace(/\/$/, '');
		const openRecord = () => base && vscode.env.openExternal(vscode.Uri.parse(`${base}/${record.table}.do?sys_id=${record.id}`));
		if (action === 'open') {
			openRecord();
			return;
		}

		if (!hasBaseline(root, link.instance)) {
			vscode.window.showInformationMessage(`Changes on ${link.instance} are tracked from the first deploy or pull of this app.`);
			return;
		}
		const key = this.checkKey(link.instance);
		const cached = this.checks.get(key);
		// Recent enough to trust, or check again: the change may have just been made.
		if (!(cached?.state === 'done' && !cached.stale && Date.now() - cached.at < 60 * 1000)) {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Checking ${link.instance} for changes` }, () => this.checkInstance(true));
		}
		const check = this.checks.get(key);
		if (check?.state === 'error') {
			if (check.session) showSessionProblem(check.message, link.instance, base);
			else vscode.window.showWarningMessage(`Could not check ${link.instance} for changes: ${check.message}`);
			return;
		}
		if (check?.state !== 'done') {
			vscode.window.showWarningMessage(`Could not check ${link.instance} for changes. Is the ScriptSync helper tab open?`);
			return;
		}
		const change = check.changes.find((c) => c.file === recordFileName(record));
		if (!change) {
			const choice = await vscode.window.showInformationMessage(`${record.label} has no changes on ${link.instance} since your last deploy or pull.`, 'Open on instance');
			if (choice) openRecord();
			return;
		}
		const node = new Node(change.label, { change });
		if (action === 'compare') await this.showDiff(node);
		else if (action === 'accept') await this.accept(node);
		else await this.dismiss(node);
	}

	private refreshSoon() {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => this.refresh(), 800);
	}

	/** `userInitiated`: the Refresh button; every other refresh checks quietly. */
	private async refresh(checkInstance = false, userInitiated = false) {
		const root = await this.resolveRoot();
		if (root !== this.root) {
			this.root = root;
			checkInstance = true;
		}
		this.emitter.fire(undefined);
		if (checkInstance && this.view?.visible) this.checkInstance(false, !userInitiated);
	}

	private checkKey(instance: string) {
		return `${this.root}|${instance}`;
	}

	private inflight = new Map<string, Promise<void>>();

	/** Download the app and compare it with the baseline of the last sync. */
	/** `background`: started by the view itself, not by the user (see downloadInstanceRecords). */
	private checkInstance(force: boolean, background = false): Promise<void> {
		const key = this.root ? this.checkKey(readDeployLink(this.root)?.instance || '') : '';
		const running = this.inflight.get(key);
		if (running) return running;
		const work = this.runCheck(force, background).finally(() => this.inflight.delete(key));
		this.inflight.set(key, work);
		return work;
	}

	private async runCheck(force: boolean, background: boolean) {
		const root = this.root;
		if (!root) return;
		let project: NowSdkProject;
		try {
			project = readNowSdkProject(root);
		} catch {
			return;
		}
		const link = readDeployLink(root);
		const deps = this.deps();
		if (!link || !hasBaseline(root, link.instance) || !/^[0-9a-f]{32}$/.test(project.scopeId)) return;
		if (!deps.isRunning() || deps.helperCapabilities()?.sdkPull !== 1 || deps.helperProFeatures() === false) return;
		const settings = deps.getInstanceSettings(link.instance);
		const key = this.checkKey(link.instance);
		if (!settings?.url || !settings?.g_ck) {
			this.checks.set(key, { state: 'error', message: `No session for ${link.instance} yet.`, at: Date.now(), session: true });
			this.emitter.fire(undefined);
			return;
		}
		const previous = this.checks.get(key);
		if (previous?.state === 'checking') return;
		if (!force && previous && !(previous.state === 'done' && previous.stale) && Date.now() - previous.at < CHECK_STALE_MS) return;
		const revision = this.connectionRevision;

		this.checks.set(key, { state: 'checking' });
		this.emitter.fire(undefined);
		try {
			// Refresh (force) asks the instance; otherwise a download made moments
			// ago by a deploy, pull or earlier check is reused.
			const records = await downloadInstanceRecords(deps, project, { name: link.instance, url: settings.url, g_ck: settings.g_ck }, force || (previous?.state === 'done' && previous.stale) ? 0 : RECENT_DOWNLOAD_MS, background);
			this.checks.set(key, { state: 'done', changes: instanceChangesFromRecords(root, link.instance, records), records, at: Date.now(), stale: revision !== this.connectionRevision });
		} catch (e: any) {
			const message = e?.message || String(e);
			this.checks.set(key, { state: 'error', message, at: Date.now(), session: isSessionProblem(message) });
		}
		this.emitter.fire(undefined);
	}

	private async build() {
		if (!this.root) return;
		const root = this.root;
		await vscode.window.withProgress({ location: { viewId: 'nowSdkTreeView' }, title: 'Building' }, async () => {
			try {
				await runNowSdk(root, ['build']);
			} catch (e: any) {
				vscode.window.showErrorMessage(`Build failed: ${e?.message || e}`);
			}
		});
		this.sourceIndex = undefined;
		this.refresh();
	}

	getTreeItem(node: Node): vscode.TreeItem {
		return node;
	}

	getChildren(node?: Node): Node[] {
		if (node) return node.children ? node.children() : [];
		if (this.view) {
			this.view.title = 'NOW SDK App';
			this.view.description = undefined;
		}
		if (!this.root) return [];
		let project: NowSdkProject;
		try {
			project = readNowSdkProject(this.root);
		} catch (e: any) {
			return [new Node(`now.config.json cannot be read`, { icon: 'error', color: 'errorForeground', tooltip: e?.message })];
		}
		if (this.view) {
			this.view.title = project.name;
			this.view.description = `${project.scope} · ${project.version}`;
		}
		return this.rootNodes(project);
	}

	private rootNodes(project: NowSdkProject): Node[] {
		const deps = this.deps();
		const nodes: Node[] = [];
		const link = readDeployLink(project.root);
		const settings = link ? deps.getInstanceSettings(link.instance) : null;
		const instanceUrl = (settings?.url || link?.url || '').replace(/\/$/, '');
		const open = (target: string): vscode.Command | undefined => instanceUrl
			? { command: 'sn-scriptsync.nowSdkView.openUrl', title: 'Open on the instance', arguments: [`${instanceUrl}/${target}`] }
			: undefined;

		// Only when something needs attention.
		try {
			assertSupportedSdk(project.root);
		} catch (e: any) {
			nodes.push(new Node('ServiceNow SDK not supported', { icon: 'error', color: 'errorForeground', description: 'use now-sdk directly', tooltip: e?.message }));
		}
		const capabilities = deps.helperCapabilities();
		if (!deps.isRunning()) {
			nodes.push(new Node('sn-scriptsync is off', { icon: 'debug-disconnect', color: 'list.warningForeground', description: 'enable to deploy and pull', command: { command: 'extension.snScriptSyncEnable', title: 'Enable' } }));
		} else if (!capabilities) {
			nodes.push(new Node('Helper tab not connected', { icon: 'debug-disconnect', color: 'list.warningForeground', description: 'open it in the browser', tooltip: 'Open the ScriptSync helper tab in the browser (the SN Utils popup, or /token on the instance) to deploy and pull.' }));
		} else if (deps.helperProFeatures() === false) {
			nodes.push(new Node('Deploy and pull are Pro features', { icon: 'star-empty', description: 'start a free trial', command: { command: 'sn-scriptsync.nowSdkView.openUrl', title: 'Start trial', arguments: ['https://snutils.com/trial?utm_source=scriptsync&utm_medium=referral&utm_campaign=sdk_view'] } }));
		}

		// Instance
		nodes.push(link
			? new Node(link.instance, {
				icon: 'server-environment',
				description: 'deploys to and pulls from',
				tooltip: `${project.name} deploys to and pulls from ${instanceUrl || link.instance}. Click to change.`,
				command: { command: 'sn-scriptsync.nowSdkView.changeInstance', title: 'Change instance' },
				contextValue: 'nowSdkInstance',
			})
			: new Node('No instance yet', {
				icon: 'server-environment',
				description: 'pick one',
				command: { command: 'sn-scriptsync.nowSdkView.changeInstance', title: 'Choose instance' },
			}));

		// Changes on the instance since the last sync
		if (link) {
			const check = this.checks.get(this.checkKey(link.instance));
			const settings = deps.getInstanceSettings(link.instance);
			const cached = (check?.state === 'done' && check.stale) || !deps.isRunning() || capabilities?.sdkPull !== 1 || deps.helperProFeatures() === false || !settings?.url || !settings?.g_ck;
			const checked = check && check.state !== 'checking' ? `checked ${relativeTime(new Date(check.at).toISOString())}` : '';
			if (!hasBaseline(project.root, link.instance)) {
				nodes.push(new Node('Instance changes not tracked yet', { icon: 'eye-closed', description: 'after the next deploy or pull', tooltip: `After a deploy or pull, ScriptSync notices when someone changes ${project.name} on ${link.instance}.` }));
			} else if (!check) {
				nodes.push(new Node(`Check ${link.instance} for changes`, { icon: 'search', command: { command: 'sn-scriptsync.nowSdkView.check', title: 'Check' } }));
			} else if (check.state === 'checking') {
				nodes.push(new Node(`Checking ${link.instance} for changes…`, { icon: 'loading~spin' }));
			} else if (check.state === 'error' && check.session) {
				// Nothing to retry until the browser has a session: open the instance instead.
				nodes.push(new Node(`Not logged in to ${link.instance}`, {
					icon: 'key',
					color: 'list.warningForeground',
					description: 'open it and run /token',
					tooltip: `${check.message} Click to open ${link.instance}; log in if asked and run /token, then refresh this view.`,
					command: open(''),
				}));
			} else if (check.state === 'error') {
				nodes.push(new Node('Could not check the instance', { icon: 'warning', color: 'list.warningForeground', description: 'click to retry', tooltip: check.message, command: { command: 'sn-scriptsync.nowSdkView.check', title: 'Retry' } }));
			} else if (check.changes.length === 0) {
				nodes.push(new Node(cached ? `Last check: no changes on ${link.instance}` : `No changes on ${link.instance}`, {
					icon: cached ? 'history' : 'pass', color: cached ? undefined : 'testing.iconPassed',
					description: `${cached ? 'cached · ' : ''}${checked}`,
					tooltip: cached ? 'This is a saved result. Connect the helper with a current instance session and refresh to check again.' : undefined,
					command: { command: 'sn-scriptsync.nowSdkView.check', title: 'Check again' },
				}));
			} else {
				const changes = check.changes;
				const allGenerated = changes.every((c) => c.generated);
				nodes.push(new Node(`${cached ? 'Last check: ' : ''}${changes.length} record${changes.length === 1 ? '' : 's'} changed on ${link.instance}`, {
					icon: 'warning',
					color: 'list.warningForeground',
					description: cached ? `cached · ${checked}` : 'review before you deploy',
					tooltip: allGenerated
						? `The last check found changes to generated records in ${project.name}. Try Accept to apply supported changes to your source; changes it cannot place need a manual edit.${cached ? ' Connect the helper and refresh for a current check.' : ''}`
						: `The last check found changes to ${project.name} on ${link.instance} since your last deploy or pull. Review them and choose Accept or Keep local version.${cached ? ' Connect the helper and refresh for a current check.' : ''}`,
					contextValue: allGenerated ? 'nowSdkInstanceChangedGenerated' : 'nowSdkInstanceChanged',
					expanded: true,
					children: () => changes.map((c) => {
						const row = new Node(c.label, {
							icon: c.status === 'new' ? 'diff-added' : c.status === 'removed' ? 'diff-removed' : 'diff-modified',
							description: c.generated ? `${c.status} · ${c.reason}` : c.status,
							tooltip: c.generated
								? `${c.label}: ${c.reason}. A pull cannot bring this change in. Try Accept to apply it to your source; if it cannot be placed, edit the source by hand. Click to see what changed.`
								: 'Click to see what changed on the instance.',
							change: c,
							contextValue: 'nowSdkChange',
						});
						row.command = { command: 'sn-scriptsync.nowSdkView.diff', title: 'Show changes', arguments: [row] };
						return row;
					}),
				}));
			}
		}

		// Local edits since the last deploy
		const markers = readSyncMarkers(project.root);
		const lastDeploy = markers.deploy && (!link || markers.deploy.instance === link.instance) ? markers.deploy : null;
		if (!lastDeploy) {
			nodes.push(new Node(link ? `Not deployed to ${link.instance} yet` : 'Not deployed yet', {
				icon: 'cloud-upload',
				description: 'deploy',
				command: { command: 'sn-scriptsync.nowSdkView.deploy', title: 'Deploy' },
				contextValue: 'nowSdkLocalEdits',
			}));
		} else {
			const edited = filesEditedSince(project.root, lastDeploy.at);
			nodes.push(edited.length === 0
				? new Node('No edits since the last deploy', { icon: 'pass', color: 'testing.iconPassed' })
				: new Node(`${edited.length} file${edited.length === 1 ? '' : 's'} edited since the last deploy`, {
					icon: 'edit',
					description: 'not on the instance yet',
					contextValue: 'nowSdkLocalEdits',
					children: () => edited.map((file) => {
						const uri = vscode.Uri.file(path.join(project.root, file));
						return new Node(path.basename(file), { resourceUri: uri, description: path.dirname(file), command: { command: 'vscode.open', title: 'Open', arguments: [uri] } });
					}),
				}));
		}

		// History
		const history = [
			lastDeploy ? `deployed ${relativeTime(lastDeploy.at)}` : '',
			markers.pull ? `pulled ${relativeTime(markers.pull.at)}` : '',
		].filter(Boolean);
		if (history.length) {
			const text = history.join(' · ');
			nodes.push(new Node(text.charAt(0).toUpperCase() + text.slice(1), {
				icon: 'history',
				tooltip: [lastDeploy ? `Last deploy: ${new Date(lastDeploy.at).toLocaleString()} to ${lastDeploy.instance}` : '', markers.pull ? `Last pull: ${new Date(markers.pull.at).toLocaleString()} from ${markers.pull.instance}` : ''].filter(Boolean).join('\n'),
			}));
		}

		// What is in the app
		const groups: AppRecordGroup[] = readAppContents(project.appOutputDir);
		const total = groups.reduce((n, g) => n + g.records.length, 0);
		nodes.push(groups.length === 0
			? new Node('Build to list what is in the app', { icon: 'package', command: { command: 'sn-scriptsync.nowSdkView.build', title: 'Build' } })
			: new Node('In the app', {
				icon: 'package',
				description: `${total} record${total === 1 ? '' : 's'}`,
				children: () => groups.map((g) => new Node(g.label, {
					description: String(g.records.length),
					children: () => g.records.map((r) => {
						// Click opens where the record is defined; the globe opens it on the instance.
						const source = this.definitionOf(project.root, r.sysId);
						const url = instanceUrl ? `${instanceUrl}/${r.link}` : undefined;
						const uri = source ? vscode.Uri.file(path.join(project.root, source.file)) : undefined;
						return new Node(r.name, {
							description: g.table === 'sys_ui_page' ? r.link : undefined,
							tooltip: new vscode.MarkdownString([
								source ? `Click to open its definition in \`${source.file}\`.` : 'Not found in your source: click to open it on the instance.',
								url ? `$(globe) opens it on ${link?.instance}.` : 'Pick an instance to open it there.',
							].join('\n\n'), true),
							command: uri
								? { command: 'sn-scriptsync.nowSdkView.openSource', title: 'Open definition', arguments: [uri, source!.start] }
								: url ? open(r.link) : undefined,
							contextValue: url ? 'nowSdkAppRecord' : undefined,
							url,
						});
					}),
				})),
			}));

		// Links
		nodes.push(new Node('More', {
			icon: 'link-external',
			children: () => [
				...(instanceUrl && /^[0-9a-f]{32}$/.test(project.scopeId)
					? [new Node('Open the app on the instance', { icon: 'globe', command: open(`sys_app.do?sys_id=${project.scopeId}`) })]
					: []),
				new Node('Documentation', { icon: 'book', command: { command: 'sn-scriptsync.nowSdkView.openUrl', title: 'Docs', arguments: [DOCS_URL] } }),
				new Node('Send feedback (beta)', { icon: 'feedback', command: { command: 'sn-scriptsync.nowSdkView.openUrl', title: 'Feedback', arguments: [FEEDBACK_URL] } }),
			],
		}));
		return nodes;
	}
}
