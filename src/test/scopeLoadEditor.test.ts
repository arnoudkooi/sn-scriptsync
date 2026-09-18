import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { discoverScopeFields, readAllPages, FetchPage } from '../ScopeDiscovery';

// Exercise the editor's real disk-writing and reporting functions without starting VS Code transports.
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const functions = ts.transpileModule(source.slice(source.indexOf('function writeScopeFile('), source.indexOf('function writeInstanceScope(')), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

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
