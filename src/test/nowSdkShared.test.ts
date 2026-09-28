import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

// The standalone bridge (packages/snu) compiles separately and cannot import
// from src/, so it carries a copy of the NOW SDK modules. They must stay
// byte-identical: fix src/ and copy the file over.
const repoRoot = path.resolve(__dirname, '..', '..');

for (const file of ['NowSdkProject.ts', 'NowSdkBuild.ts', 'NowSdkChoices.ts', 'NowSdkSource.ts', 'NowSdkPull.ts', 'NowSdkFlows.ts']) {
	test(`packages/snu carries an identical copy of ${file}`, () => {
		const original = fs.readFileSync(path.join(repoRoot, 'src', file), 'utf8');
		const copy = fs.readFileSync(path.join(repoRoot, 'packages', 'snu', 'src', 'nowsdk', file), 'utf8');
		assert.ok(original === copy, `packages/snu/src/nowsdk/${file} differs from src/${file}; copy it over`);
	});
}
