// Run after `npm run build --prefix packages/snu`:
//   node --test scripts/test-snu-package.mjs
// Packs @snutils/snu exactly as npm would publish it, unpacks the tarball into
// a folder outside this repository and pulls a scope whose live dictionary
// cannot be read. Repository tests cannot catch a file missing from the
// package, because the repository copy is always found first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkgDir = path.join(root, 'packages', 'snu');

test('the published package ships the bundled field definitions and pull_scope falls back to them', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-package-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', tmp], { cwd: pkgDir, encoding: 'utf8' }).trim().split('\n').pop();
  const tarball = path.join(tmp, out);
  assert.ok(fs.existsSync(tarball), `npm pack produced ${out}`);
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n');
  assert.ok(listing.includes('package/dist/resources/metaDataRelations.json'), 'definitions are in the tarball');
  assert.ok(!listing.some(f => f.startsWith('package/dist/test/')), 'tests stay out of the tarball');

  const installed = path.join(tmp, 'install');
  fs.mkdirSync(installed);
  execFileSync('tar', ['-xzf', tarball, '-C', installed]);
  const pkg = path.join(installed, 'package');
  // Dependencies only; every file of the package itself comes from the tarball.
  fs.symlinkSync(fs.realpathSync(path.join(pkgDir, 'node_modules')), path.join(pkg, 'node_modules'), 'dir');

  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace);
  const require = createRequire(path.join(pkg, 'package.json'));
  const { StandaloneDispatcher } = require('./dist/server/dispatcher.js');
  const { PendingRegistry } = require('./dist/server/pendingRegistry.js');
  assert.ok(require.resolve('./dist/server/dispatcher.js').startsWith(fs.realpathSync(installed)), 'loaded from the unpacked tarball');

  const SCOPE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const pending = new PendingRegistry();
  t.after(() => pending.rejectAll('E_CANCELLED', 'test done'));
  const ws = {
    hasBrowserClient: () => true,
    getLiveInstances: () => [{ name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'tok', lastActiveAt: Date.now() }],
    getHelperState: () => ({ capabilities: { protocolVersion: 1 } }),
    getInstanceGate: () => 'auto',
    sendToBrowser(message) {
      const table = String(message.endpoint || '').split('/').pop();
      const ok = rows => ({ success: true, status: 200, data: { result: rows }, pagination: { totalCount: String(rows.length) } });
      const answer = table === 'sys_scope' ? ok([{ sys_id: SCOPE, scope: 'x_acme_app' }])
        : table === 'sys_metadata' ? ok([{ sys_class_name: 'sys_script_include' }, { sys_class_name: 'x_acme_custom' }])
        : table === 'sys_db_object' ? ok([{ name: 'sys_script_include', 'super_class.name': '' }, { name: 'x_acme_custom', 'super_class.name': '' }])
        : table === 'sys_dictionary' ? { success: false, status: 400, error: 'Pagination not supported' }
        : table === 'sys_script_include' ? ok([{ sys_id: 'f'.repeat(32), name: 'AcmeUtils', sys_name: 'AcmeUtils', 'sys_scope.scope': 'x_acme_app', script: 'var AcmeUtils = 1;' }])
        : { success: false, status: 404, error: `unexpected ${message.endpoint}` };
      setImmediate(() => pending.resolve(message.agentRequestId, answer));
    },
  };
  const dispatcher = new StandaloneDispatcher({ cwd: workspace, wsBridge: ws, pending, cliFlags: {} });
  const response = await dispatcher.dispatch({ id: 'pkg', command: 'pull_scope', instance: 'dev123', params: { scope: 'x_acme_app' } });
  assert.equal(response.status, 'success', JSON.stringify(response).slice(0, 500));
  assert.equal(response.result.outcome, 'partial');
  assert.deepEqual(response.result.tables.map(t => t.table), ['sys_script_include']);
  assert.ok(response.result.warnings.some(w => /^sys_script_include: Dictionary discovery failed: Pagination not supported; using bundled field definitions/.test(w)));
  assert.equal(fs.readFileSync(path.join(workspace, 'dev123', 'x_acme_app', 'sys_script_include', 'AcmeUtils.script.js'), 'utf8'), 'var AcmeUtils = 1;');
});
