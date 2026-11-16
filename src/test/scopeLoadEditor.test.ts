import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { discoverScopeFields, readAllPages, scalar, FetchPage } from '../ScopeDiscovery';

// Exercise the editor's real disk-writing and reporting functions without starting VS Code transports.
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const functions = ts.transpileModule(source.slice(source.indexOf('function writeScopeFile('), source.indexOf('function writeInstanceScope(')), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const loadFunctions = ts.transpileModule(source.slice(source.indexOf('async function pickGlobalApplication('), source.indexOf('function requestInstanceMetaData(')), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

const APP_ID = 'a'.repeat(32);
const OTHER_APP_ID = 'b'.repeat(32);
const RECORD_ID = 'c'.repeat(32);
const globalApp = { sys_id: APP_ID, name: 'Current Global App', scope: 'global', sys_class_name: 'sys_app' };
const currentArtifact = { instance: { name: 'dev', url: 'https://dev.service-now.com' }, scopeName: 'global', scope: 'global', tableName: 'sys_script_include', sys_id: RECORD_ID };

async function loadCurrentScope(options: {
    record?: any; app?: any; lookupError?: boolean; cancel?: boolean; script?: any; includeEmpty?: boolean;
} = {}) {
    const calls: { table: string; query: Record<string, string> }[] = [];
    const picks: any[] = [];
    const writes: any[] = [];
    const errors: string[] = [];
    const script = options.script || currentArtifact;
    const fetchPage: FetchPage = async (table, query) => {
        calls.push({ table, query });
        let rows: any[];
        if (table === 'sys_script_include') {
            if (options.lookupError) throw new Error('Record cannot be read');
            rows = options.record === null ? [] : [options.record || { sys_id: RECORD_ID, sys_scope: APP_ID }];
        } else if (table === 'sys_scope' && query.sysparm_query.startsWith('sys_id=')) {
            rows = options.app === null ? [] : [options.app || globalApp];
        } else if (table === 'sys_scope') {
            rows = [globalApp, { ...globalApp, sys_id: OTHER_APP_ID, name: 'Other Global App' }];
        } else if (table === 'sys_metadata') rows = [];
        else throw new Error(`Unexpected lookup: ${table}`);
        return { rows, pagination: { totalCount: String(rows.length) } };
    };
    const context = vm.createContext({
        scopeLoadActive: false, nodePath: path, getWorkspaceRoot: () => '/workspace', readAllPages, scalar,
        scopePageFetcher: (instance: any) => { assert.equal(instance, script.instance); return fetchPage; },
        eu: { showMessage() {} },
        vscode: { window: {
            showQuickPick: async (items: any[]) => { picks.push(items); return options.cancel ? undefined : items[1]; },
            showWarningMessage() {}, showErrorMessage: (message: string) => errors.push(message),
        } },
        writeInstanceMetaDataScope: async (message: any) => { writes.push(message); },
    });
    vm.runInContext(loadFunctions, context);
    context.requestScopeArtifacts(options.includeEmpty || false, script);
    for (let i = 0; context.scopeLoadActive && i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(context.scopeLoadActive, false, 'the load must release its busy state');
    assert.deepEqual(errors, []);
    return { calls, picks, writes };
}

test('Load Scope resolves the current Global artifact before asking the user (#169)', async () => {
    for (const sys_scope of [APP_ID, { value: APP_ID, display_value: 'Current Global App' }]) {
        const result = await loadCurrentScope({ record: { sys_id: RECORD_ID, sys_scope }, includeEmpty: true });
        assert.equal(result.picks.length, 0, 'a known owning application needs no picker');
        assert.equal(result.writes.length, 1);
        assert.equal(result.writes[0].scopeSysId, APP_ID);
        assert.equal(result.writes[0].scopeLabel, 'Current Global App');
        assert.equal(result.writes[0].includeEmpty, true);
        assert.equal(result.calls[0].table, 'sys_script_include');
        assert.equal(result.calls[0].query.sysparm_query, `sys_id=${RECORD_ID}`);
        assert.ok(result.calls.find(call => call.table === 'sys_metadata')!.query.sysparm_query.startsWith(`sys_scope=${APP_ID}^`));
    }
});

test('Load Scope falls back to an explicit choice when ownership cannot be established', async () => {
    for (const options of [
        { record: null }, { lookupError: true },
        { record: { sys_id: RECORD_ID, sys_scope: 'global' } },
        { record: { sys_id: RECORD_ID, sys_scope: APP_ID + '^ORscope=global' } },
        { record: { sys_id: 'd'.repeat(32), sys_scope: APP_ID } },
        { app: null }, { app: { ...globalApp, sys_id: OTHER_APP_ID } },
        { app: { ...globalApp, scope: 'x_other_app' } },
        { app: { ...globalApp, sys_class_name: 'sys_scope' } },
    ]) {
        const result = await loadCurrentScope(options);
        assert.equal(result.picks.length, 1);
        assert.equal(result.writes[0].scopeSysId, OTHER_APP_ID, 'the user choice controls the fallback load');
        assert.ok(result.calls.find(call => call.table === 'sys_metadata')!.query.sysparm_query.startsWith(`sys_scope=${OTHER_APP_ID}^`));
    }
});

test('a Global file without a valid record identity uses the picker without a record lookup', async () => {
    for (const script of [
        { ...currentArtifact, sys_id: '' },
        { ...currentArtifact, sys_id: RECORD_ID + '^ORactive=true' },
        { ...currentArtifact, tableName: '../sys_script_include' },
    ]) {
        const result = await loadCurrentScope({ script });
        assert.equal(result.picks.length, 1);
        assert.deepEqual(result.calls.map(call => call.table), ['sys_scope', 'sys_metadata']);
    }
});

test('explicit app links and scoped files keep their known application', async () => {
    for (const scopeName of ['global', 'x_acme_app']) {
        const result = await loadCurrentScope({ script: { ...currentArtifact, scopeName, scope: APP_ID, scopeLabel: 'Explicit app' } });
        assert.equal(result.picks.length, 0);
        assert.deepEqual(result.calls.map(call => call.table), ['sys_metadata']);
        assert.equal(result.writes[0].scopeSysId, APP_ID);
        assert.equal(result.writes[0].scopeLabel, 'Explicit app');
    }
});

test('cancelling the fallback picker does not load any application', async () => {
    const result = await loadCurrentScope({ record: null, cancel: true });
    assert.equal(result.picks.length, 1);
    assert.equal(result.writes.length, 0);
    assert.ok(!result.calls.some(call => call.table === 'sys_metadata'));
});

test('editor loads live fields, waits for disk writes, and persists complete schema and skip reasons', async t => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-editor-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const messages: string[] = [];
    const fetchPage: FetchPage = async (table, query) => {
        let rows: any[];
        if (table === 'sys_db_object') rows = ['x_live', 'sp_theme'].map(name => ({ name, 'super_class.name': '' }));
        else if (table === 'sys_dictionary') rows = [
            { name: 'x_live', element: 'markup', 'internal_type.name': 'xml' },
            { name: 'x_live', element: 'css', 'internal_type.name': 'css' },
            { name: 'sp_theme', element: 'header', 'internal_type.name': 'reference' },
        ];
        else if (table === 'x_live') rows = [{ sys_id: 'a', sys_name: 'Live', markup: '<live/>', css: '' }];
        else throw new Error(`Unexpected table ${table}`);
        return { rows, pagination: { totalCount: String(rows.length) } };
    };
    const context = vm.createContext({
        metaDataRelations: null, scopeJson: {}, scopeLoadCounts: {}, scopeTableResponseCount: 0,
        getWorkspaceRoot: () => workspace, path, nodePath: path, __filename: path.join(root, 'out/extension.js'),
        discoverScopeFields, readAllPages, scopePageFetcher: () => fetchPage, setScopeTree() {},
        Constants: { FOLDERRECORDTABLES: [], FIELDTYPES: { xml: { extension: '.xml' }, css: { extension: '.scss' } } },
        eu: {
            getFileAsJson: (file: string) => file.endsWith('scopes.json') ? { x_scope: 'scopeid' } : JSON.parse(fs.readFileSync(path.join(root, 'resources/metaDataRelations.json'), 'utf8')),
            writeOrReadNameToSysIdMapping: () => ({}),
            showMessage: (message: string) => messages.push(message),
            writeFile: (file: string, content: string, _open: boolean, cb: (error?: Error) => void) => {
                setTimeout(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); cb(); }, 5);
            },
        },
    });
    vm.runInContext(functions, context);
    const filePath = path.join(workspace, 'dev/x_scope/scope.json');
    await context.writeInstanceMetaDataScope({ instance: { name: 'dev', url: 'https://dev.service-now.com' }, scopeName: 'x_scope', filePath,
        results: [{ sys_id: 'a', sys_name: 'Live', sys_class_name: 'x_live' }, { sys_id: 'b', sys_name: 'Theme', sys_class_name: 'sp_theme' }],
        discoveryComplete: true, discoveryWarnings: [], includeEmpty: false,
    });
    const scope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(scope.loadReport.complete, true);
    assert.equal(scope.loadReport.filesWritten, 1);
    assert.equal(scope.loadReport.skippedEmpty, 1);
    assert.deepEqual(scope.loadReport.skippedTables, [{ table: 'sp_theme', reason: 'no_scriptable_fields' }]);
    assert.equal(scope.tableDefinitions.x_live.codeFields.markup.type, 'xml');
    assert.equal(fs.readFileSync(path.join(workspace, 'dev/x_scope/x_live/Live.markup.xml'), 'utf8'), '<live/>');
    assert.match(messages.at(-1)!, /Scope load finished/);
});
