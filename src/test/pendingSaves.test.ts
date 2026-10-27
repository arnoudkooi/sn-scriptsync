import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { SyncTracker, revisionOf } from '../syncTracker';
import { ExplicitSaveIntents, decideEditorSave, filesForSync } from '../saveIntent';

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const parsed = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.ES2020, true);
const functionNames = new Set([
    'enqueueForReview', 'isHeldPendingFile', 'showPendingReason', 'isDuplicateConfirmedSave',
    'helperConfirmsSaves', 'saveTargetOf', 'trackSave', 'clearSaveTimer', 'handleSaveResult',
    'abandonSave', 'abandonInFlightSaves', 'reportUnconfirmed', 'pauseAutoSyncQuietly',
    'settleAfterSave', 'rearmAutoSync', 'pushQueuedFile', 'processPendingFiles',
    'enqueuePendingFile', 'setupWatcher', 'pushEditorSave',
]);
// Run the actual queue, watcher, editor-save and acknowledgement wiring. Only
// the VS Code surface, transport and timers are replaced; no live instance.
const statements = parsed.statements.filter(statement =>
    ts.isFunctionDeclaration(statement) && functionNames.has(statement.name?.text)
    || ts.isExpressionStatement(statement) && statement.getText(parsed).startsWith('vscode.workspace.onDidSaveTextDocument('));
assert.equal(statements.length, functionNames.size + 1);
const script = ts.transpileModule(statements.map(s => s.getText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(t: TestContext, overrides: Record<string, any> = {}) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-saves-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const folder = path.join(workspace, 'dev/x_scope/sys_script_include');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'Example.script.js');
    const other = path.join(folder, 'Other.script.js');
    fs.writeFileSync(file, 'v1');
    fs.writeFileSync(other, 'other');
    const settings = { 'externalChanges.syncDelay': 1, 'externalChanges.monitorFileChanges': true, review: false, ...overrides };
    let changed: (uri: any) => void;
    let saved: (document: any) => void;
    const messages: string[] = [];
    const sent: any[] = [];
    const timers = new Set<{ callback: () => void; delay: number; unref: () => void }>();
    const mock = {
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
        TreeItem: class { constructor(public label: string) {} },
        TreeItemCollapsibleState: { None: 0 },
        ThemeIcon: class { constructor(public id: string) {} },
        ThemeColor: class { constructor(public id: string) {} },
        Uri: { file: (filePath: string) => ({ fsPath: filePath, toString: () => filePath }) },
        RelativePattern: class {},
        workspace: {
            asRelativePath: (filePath: string) => path.relative(workspace, filePath),
            getConfiguration: () => ({ get: (key: string) => settings[key] }),
            createFileSystemWatcher: () => ({ onDidChange: (callback: typeof changed) => { changed = callback; }, dispose() {} }),
            onDidSaveTextDocument: (callback: typeof saved) => { saved = callback; },
        },
        commands: { executeCommand() {} },
        window: {
            showInformationMessage: (message: string) => { messages.push(message); return Promise.resolve(undefined); },
            showWarningMessage: (message: string) => { messages.push(message); return Promise.resolve(undefined); },
            showErrorMessage: (message: string) => { messages.push(message); return Promise.resolve(undefined); },
        },
    };
    const exports: any = {};
    vm.runInNewContext(fs.readFileSync(path.join(root, 'out/QueueTreeViewProvider.js'), 'utf8'), {
        exports, require: (name: string) => name === 'vscode' ? mock : require(name), setInterval, clearInterval,
    });
    const provider = new exports.QueueTreeViewProvider();
    const view: any = {};
    provider.setView(view);
    t.after(() => provider.clearQueue());
    const tracker = new SyncTracker();
    const objectFor = (filePath: string) => ({
        instance: { name: 'dev', url: 'https://dev.example' }, scopeName: 'x_scope', tableName: 'sys_script_include',
        sys_id: filePath === other ? 'b'.repeat(32) : 'a'.repeat(32), fieldName: 'script', content: fs.readFileSync(filePath, 'utf8'),
    });
    const context = vm.createContext({
        fs, path, vscode: mock, revisionOf, decideEditorSave, filesForSync,
        getWorkspaceRoot: () => workspace, isValidInstanceRoot: () => true,
        isSyncableFile: () => true, serverRunning: true,
        watcher: undefined, queueProvider: provider, syncTracker: tracker,
        pendingFiles: new Set<string>(), heldSaves: new Set<string>(), recentManualSaves: new Map(),
        agentCreateFilesByPath: new Map(), reviewBaselines: new Map(), reviewKey: (f: string) => f,
        reviewWritesEnabled: () => settings.review, ExtensionUtils: { wasRecentSelfWrite: () => false },
        globalDebounceTimer: undefined, SAVE_CONFIRM_TIMEOUT_MS: 30_000, saveConfirmTimers: new Map(),
        deferredPushes: new Set(), connectedHelperInfo: { capabilities: { saveAck: 1 } },
        legacyHelperSaveNoticeShown: false, helperConnection: { connected: true },
        explicitSaveIntents: new ExplicitSaveIntents(), explicitPushes: new Map(), manualReasonSaves: new Set(),
        noteHeldSave() {}, markFileAsDirty() {},
        eu: { fileNameToObject: objectFor }, sendToServiceNow: (obj: any) => sent.push({ ...obj }),
        auditLog() {}, buildRunId: () => 'test', acceptReviewBaseline() {}, rebaseReviewBaseline() {},
        describeSaveError: () => 'Access denied', relayErrorToAgent() {},
        setTimeout: (callback: () => void, delay: number) => {
            const timer = { callback, delay, unref() {} }; timers.add(timer); return timer;
        },
        clearTimeout: (timer: any) => timers.delete(timer),
    });
    context.saveFieldsToServiceNow = (doc: any, _fromEditor: boolean, intent: string) => {
        const fp = typeof doc === 'string' ? doc : doc.fileName;
        const obj = objectFor(fp);
        context.trackSave(obj, [{ filePath: fp, content: obj.content }], 'test');
        sent.push({ ...obj, syncIntent: intent });
        return true;
    };
    vm.runInContext(script, context);
    context.setupWatcher();
    return {
        file, other, sent, messages, context, tracker, provider, view, settings,
        change: (fp = file, content?: string) => {
            if (content !== undefined) fs.writeFileSync(fp, content);
            changed({ fsPath: fp });
        },
        save: (fp = file, content?: string, explicit = false) => {
            if (content !== undefined) fs.writeFileSync(fp, content);
            if (explicit) context.explicitSaveIntents.mark(fp);
            saved({ uri: mock.Uri.file(fp), fileName: fp, version: 1, getText: () => fs.readFileSync(fp, 'utf8') });
        },
        auto: () => {
            const timer = [...timers].find(timer => timer.delay === 1000);
            assert.ok(timer, 'an auto-sync is scheduled');
            timers.delete(timer); timer.callback();
        },
        answer: (ok = true, index = sent.length - 1) => context.handleSaveResult({ syncId: sent[index].syncId, ok }),
        rows: () => provider.getChildren(),
    };
}

test('confirmed auto-sync stays out of Pending Saves after repeated delayed watcher and editor events', async t => {
    const f = fixture(t);
    f.change(); f.auto();
    assert.match((await f.rows())[0].description, /Syncing/);
    f.answer();
    f.change(); f.change(); f.save();
    assert.equal((await f.rows()).length, 0);
    assert.equal(f.context.pendingFiles.size, 0);
    assert.equal(f.context.heldSaves.size, 0);
    assert.equal(f.sent.length, 1);
    assert.equal(f.view.badge, undefined);
});

test('a newer disk edit stays visible after the earlier save is confirmed, then syncs and clears', async t => {
    const f = fixture(t);
    f.change(); f.auto();
    f.change(f.file, 'v2');
    f.answer();
    const row = (await f.rows())[0];
    assert.match(row.description, /^New changes pending/);
    assert.match(row.description, /dev/);
    assert.match(row.tooltip, /previous version was saved/);
    f.auto();
    assert.equal(f.sent[1].content, 'v2');
    f.answer();
    assert.equal((await f.rows()).length, 0);
});

test('a newer editor save remains held with an explanation and cannot be flushed by auto-sync or an agent', async t => {
    const f = fixture(t);
    f.change(); f.auto();
    f.save(f.file, 'v2'); f.answer();
    const row = (await f.rows())[0];
    assert.match(row.description, /^Waiting for Sync Now/);
    assert.match(row.tooltip, /previous version was saved/);
    assert.match(row.tooltip, /saved locally without Save & Sync/);
    f.context.processPendingFiles('queue_auto_sync');
    f.context.processPendingFiles('agent_sync');
    assert.equal(f.sent.length, 1);
    f.context.processPendingFiles('queue_sync');
    assert.equal(f.sent[1].content, 'v2');
    f.answer();
    assert.equal((await f.rows()).length, 0);
});

test('a real edit immediately after a confirmed editor save is not swallowed by the timing guard', async t => {
    const f = fixture(t);
    f.save(f.file, 'v1', true); f.answer();
    f.change(f.file, 'v2');
    assert.equal((await f.rows()).length, 1);
    f.auto();
    assert.equal(f.sent[1].content, 'v2');
});

test('an explicit Save & Sync still sends identical content after a confirmation', t => {
    const f = fixture(t);
    f.change(); f.auto(); f.answer();
    f.save(f.file, undefined, true);
    assert.equal(f.sent.length, 2);
});

test('mixed queues show held files separately and keep the other file countdown', async t => {
    const f = fixture(t);
    f.change();
    f.save(f.other);
    assert.match(f.view.description, /1 auto-sync in/);
    assert.match(f.view.description, /1 waiting for Sync Now/);
    f.auto();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].content, 'v1');
    assert.match(f.view.description, /1 syncing/);
    assert.match(f.view.description, /1 waiting for Sync Now/);
    f.answer();
    assert.match((await f.rows())[0].description, /^Waiting for Sync Now/);
    assert.doesNotMatch(f.view.description, /Monitoring|auto-sync/);
});

test('adding a held file to a paused queue preserves the other file pause and resume', t => {
    const f = fixture(t);
    f.change();
    assert.equal(f.provider.togglePause(), true);
    f.context.clearTimeout(f.context.globalDebounceTimer);
    f.context.globalDebounceTimer = undefined;
    f.save(f.other);
    assert.match(f.view.description, /1 paused/);
    assert.match(f.view.description, /1 waiting for Sync Now/);
    assert.equal(f.provider.togglePause(), false, 'the auto-sync queue can still be resumed');
    f.context.rearmAutoSync();
    f.auto();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].content, 'v1');
});

for (const outcome of ['failed', 'timeout', 'disconnect']) {
    test(`${outcome} saves stay visible with their reason after duplicate events`, async t => {
        const f = fixture(t);
        f.change(); f.auto();
        if (outcome === 'failed') f.answer(false);
        else if (outcome === 'timeout') f.context.abandonSave(f.sent[0].syncId, 'No answer');
        else f.context.abandonInFlightSaves('Disconnected');
        f.change(); f.save();
        assert.equal((await f.rows()).length, 1);
        assert.match((await f.rows())[0].description, outcome === 'failed' ? /Failed/ : /Unconfirmed/);
        assert.match(f.view.description, /need attention/);
        f.context.processPendingFiles('queue_auto_sync');
        assert.equal(f.sent.length, 1);
    });
}

test('a staged review cannot be dismissed just because its content matches an earlier save', async t => {
    const f = fixture(t);
    f.change(); f.auto(); f.answer();
    f.context.reviewBaselines.set(f.file, { existed: true, content: 'v1' });
    f.context.enqueueForReview(f.file);
    f.change(); f.save();
    const row = (await f.rows())[0];
    assert.match(row.description, /^Waiting for Sync Now/);
    assert.match(row.tooltip, /Review before sync/);
    f.context.processPendingFiles('queue_auto_sync');
    assert.equal(f.sent.length, 1);
});

test('manual mode says Sync Now, while a legacy helper keeps its existing send-and-remove behavior', async t => {
    const f = fixture(t, { 'externalChanges.syncDelay': 0 });
    f.context.connectedHelperInfo = { capabilities: {} };
    f.change();
    assert.match((await f.rows())[0].description, /^Waiting for Sync Now/);
    f.context.processPendingFiles('queue_sync');
    assert.equal((await f.rows()).length, 0);
    assert.equal(f.tracker.isRecentlyConfirmed(f.file, 'v1'), false, 'sending is not a confirmation');
    assert.equal(f.sent.length, 1);
});
