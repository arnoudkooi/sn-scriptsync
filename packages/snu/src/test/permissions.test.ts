import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  describePermissions,
  formatPermissions,
  parseOnOff,
  resolveGateName,
  setPermission,
  staleLiveGates,
  unsetPermission,
} from '../cli/permissions.js';
import { resolveStandaloneConfig } from '../server/config.js';

function tmpSettings(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snu-permissions-')), '.sn-scriptsync', 'settings.json');
}

test('Permissions: gate names resolve from camelCase, kebab, env var and label', () => {
  for (const alias of ['browserDebugger', 'browser-debugger', 'browser_debugger', 'SNU_ALLOW_BROWSER_DEBUGGER', 'BROWSER_DEBUGGER', 'BrowserDebugger']) {
    assert.strictEqual(resolveGateName(alias), 'browserDebugger', alias);
  }
  assert.strictEqual(resolveGateName('rest-request'), 'restRequest');
  assert.strictEqual(resolveGateName('screenshots'), undefined);
  assert.strictEqual(resolveGateName(undefined), undefined);
  assert.strictEqual(parseOnOff('on'), true);
  assert.strictEqual(parseOnOff('0'), false);
  assert.strictEqual(parseOnOff('maybe'), undefined);
});

test('Permissions: report shows defaults, file, env and the inherited update gate', () => {
  const file = tmpSettings();
  const fresh = describePermissions({ settingsFile: file, env: {} });
  assert.strictEqual(fresh.fileExists, false);
  const by = (r: typeof fresh, g: string) => r.gates.find((x) => x.gate === g)!;
  assert.deepStrictEqual([by(fresh, 'browserDebugger').value, by(fresh, 'browserDebugger').source], [false, 'default']);
  assert.deepStrictEqual([by(fresh, 'createArtifacts').value, by(fresh, 'createArtifacts').source], [true, 'default']);
  assert.deepStrictEqual([by(fresh, 'updateRecords').value, by(fresh, 'updateRecords').source], [true, 'inherited']);

  setPermission({ settingsFile: file, gate: 'browserDebugger', value: true });
  setPermission({ settingsFile: file, gate: 'createArtifacts', value: false });
  const fromFile = describePermissions({ settingsFile: file, env: {} });
  assert.deepStrictEqual([by(fromFile, 'browserDebugger').value, by(fromFile, 'browserDebugger').source], [true, 'file']);
  assert.deepStrictEqual([by(fromFile, 'updateRecords').value, by(fromFile, 'updateRecords').source], [false, 'inherited']);

  const fromEnv = describePermissions({ settingsFile: file, env: { SNU_ALLOW_BROWSER_DEBUGGER: '0' } });
  assert.deepStrictEqual([by(fromEnv, 'browserDebugger').value, by(fromEnv, 'browserDebugger').source], [false, 'env']);

  // The bridge resolves the same file the same way.
  const conf = resolveStandaloneConfig(undefined, { settingsFile: file, env: {} });
  assert.strictEqual(conf.gates.browserDebugger, true);
  assert.strictEqual(conf.gates.createArtifacts, false);
  assert.strictEqual(conf.gates.updateRecords, false);
});

test('Permissions: set creates the file, keeps other keys, and unset removes only its key', () => {
  const file = tmpSettings();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ reviewHighRisk: false, custom: 'kept' }));
  const change = setPermission({ settingsFile: file, gate: 'browserDebugger', value: true });
  assert.deepStrictEqual(change, { file, gate: 'browserDebugger', previous: undefined, next: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { reviewHighRisk: false, custom: 'kept', browserDebugger: true });

  const again = setPermission({ settingsFile: file, gate: 'browserDebugger', value: false });
  assert.strictEqual(again.previous, true);
  const removed = unsetPermission({ settingsFile: file, gate: 'browserDebugger' });
  assert.deepStrictEqual(removed, { file, gate: 'browserDebugger', previous: false, next: undefined });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { reviewHighRisk: false, custom: 'kept' });

  // A file in a fresh home is created with its directory.
  const missing = tmpSettings();
  setPermission({ settingsFile: missing, gate: 'restRequest', value: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(missing, 'utf8')), { restRequest: true });
});

test('Permissions: an unreadable settings file is refused, never clobbered', () => {
  const file = tmpSettings();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => setPermission({ settingsFile: file, gate: 'browserDebugger', value: true }));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.writeFileSync(file, '[]');
  assert.throws(() => describePermissions({ settingsFile: file, env: {} }), /JSON object/);
});

test('Permissions: report names the gates a running bridge still has differently', () => {
  const file = tmpSettings();
  setPermission({ settingsFile: file, gate: 'browserDebugger', value: true });
  const report = describePermissions({ settingsFile: file, env: {} });
  const stale = staleLiveGates(report, { pid: 1, gates: { browserDebugger: false, createArtifacts: true } });
  assert.deepStrictEqual(stale.map((g) => g.gate), ['browserDebugger']);
  assert.deepStrictEqual(staleLiveGates(report, { pid: 1, gates: { browserDebugger: true } }), []);
  assert.deepStrictEqual(staleLiveGates(report, null), []);
  const text = formatPermissions(report, { pid: 4242, version: '0.3.4', gates: { browserDebugger: false } });
  assert.match(text, /Browser Debugger .*on/);
  assert.match(text, /PID 4242, @snutils\/snu 0\.3\.4/);
  assert.match(text, /snu restart/);
});
