import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compactSearchResults } from '../server/dispatcher.js';
import { repositoryWriteWarning } from '../server/workspaceCheck.js';
import { getToolByName } from '../registry.js';
import { formatHumanOutput } from '../cli/format.js';

const FULL = [{
  tableName: 'sys_script_include', tableLabel: 'Script Include', rowCount: 120,
  hits: [
    { sysId: 'a'.repeat(32), name: 'AcmeTaskUtils', matches: [{ field: 'script', lineMatches: [{ lineNumber: 4, content: 'x'.repeat(5000), isMatch: true }] }] },
    { sysId: 'b'.repeat(32), name: 'AcmeTaskUtilsTest', matches: [] },
  ],
}];

test('compact code search keeps table, true count and names only', () => {
  const compact = compactSearchResults(FULL);
  assert.deepStrictEqual(compact, [{ table: 'sys_script_include', label: 'Script Include', count: 120, names: ['AcmeTaskUtils', 'AcmeTaskUtilsTest'] }]);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(FULL).length / 10);
  assert.deepStrictEqual(compactSearchResults(undefined), []);
});

test('snu search --compact and snu query --no-links reach the bridge as params', () => {
  const search = getToolByName('snu_code_search')!;
  assert.strictEqual((search.mapInput({ term: 'abc', compact: true }) as any).params.compact, true);
  assert.strictEqual('compact' in (search.mapInput({ term: 'abc' }) as any).params, false);
  const query = getToolByName('snu_query_records')!;
  assert.strictEqual((query.mapInput({ table: 'incident', 'no-links': true }) as any).params.referenceLinks, false);
  assert.strictEqual((query.mapInput({ table: 'incident' }) as any).params.limit, undefined, 'the bridge applies and reports the default');
  assert.strictEqual((query.mapInput({ table: 'incident', limit: '25' }) as any).params.limit, 25);
});

test('human output: search shows real table names and totals, query says when more match', () => {
  const full = formatHumanOutput('code_search', { term: 'acme', stats: {}, results: FULL });
  assert.match(full, /Script Include \(sys_script_include\)/);
  assert.match(full, /2 match\(es\) of 120/);
  assert.doesNotMatch(full, /undefined/);
  const compact = formatHumanOutput('code_search', { term: 'acme', stats: {}, compact: true, results: compactSearchResults(FULL) });
  assert.match(compact, /120 record\(s\), 2 shown/);
  const query = formatHumanOutput('query_records', { table: 'incident', records: [{ sys_id: 'a1' }], limit: 1, total: 9, more: true, defaultFields: true });
  assert.match(query, /Showing 1 of 9/);
  assert.match(query, /--limit/);
  assert.match(query, /--fields/);
});

test('bridge start warns inside a repository that is not a ScriptSync workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-repo-check-'));
  try {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    assert.strictEqual(repositoryWriteWarning(plain), undefined, 'no repository above');

    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'));
    assert.match(repositoryWriteWarning(repo)!, /git repository/);
    assert.match(repositoryWriteWarning(path.join(repo, 'src'))!, /git repository/, 'a subfolder of the repository counts');

    fs.mkdirSync(path.join(repo, 'dev123'));
    fs.writeFileSync(path.join(repo, 'dev123', '_settings.json'), '{}');
    assert.strictEqual(repositoryWriteWarning(repo), undefined, 'a workspace kept in git on purpose is left alone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
