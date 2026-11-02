import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
const start = source.indexOf('function getChangelogHighlightsHtml(');
const end = source.indexOf('\n// Minimal, safe Markdown', start);
assert.ok(start >= 0 && end > start);
const helper = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;

for (const filename of ['changelog.md', 'CHANGELOG.md']) {
  test(`welcome release notes work with ${filename} on a case-sensitive filesystem`, () => {
    const notes = '## 4.10.4 (2026-11-02)\n- Current extension fix\n\n## `@snutils/snu` 0.6.3\n- CLI fix\n';
    const read = (file: string) => {
      if (path.basename(file) === filename) return notes;
      throw Object.assign(new Error('Missing changelog'), { code: 'ENOENT' });
    };
    const highlights = vm.runInNewContext(helper + '\ngetChangelogHighlightsHtml', {
      fs: { readFileSync: read }, path, markdownToHtml: (value: string) => value,
      debugLog() {},
    })({ extensionPath: '/installed-extension' }, '4.10.4');
    assert.match(highlights, /Current extension fix/);
    assert.doesNotMatch(highlights, /CLI fix/);
  });
}
