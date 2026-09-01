import test from 'node:test';
import assert from 'node:assert';
import { resolveStandaloneConfig } from '../server/config.js';

test('Config: standalone host gates fail-closed by default', () => {
  const conf = resolveStandaloneConfig();
  assert.strictEqual(conf.gates.backgroundScripts, false);
  assert.strictEqual(conf.gates.deleteRecords, false);
  assert.strictEqual(conf.gates.restRequest, false);
  assert.strictEqual(conf.gates.browserDebugger, false);
  assert.strictEqual(conf.gates.createArtifacts, true);
  assert.strictEqual(conf.reviewHighRisk, true);
});

test('Config: honors explicit CLI flags and environment variables', () => {
  process.env.SNU_ALLOW_BACKGROUND_SCRIPTS = '1';
  process.env.SNU_ALLOW_DELETE_RECORDS = 'true';

  try {
    const conf = resolveStandaloneConfig({
      browserDebugger: true,
    });

    assert.strictEqual(conf.gates.backgroundScripts, true);
    assert.strictEqual(conf.gates.deleteRecords, true);
    assert.strictEqual(conf.gates.browserDebugger, true);
    assert.strictEqual(conf.gates.restRequest, false);
  } finally {
    delete process.env.SNU_ALLOW_BACKGROUND_SCRIPTS;
    delete process.env.SNU_ALLOW_DELETE_RECORDS;
  }
});

test('Config: updateRecords follows the create decision unless set explicitly', () => {
  const inherited = resolveStandaloneConfig({ createArtifacts: false });
  assert.strictEqual(inherited.gates.updateRecords, false, 'a host that may not create may not overwrite either');

  const explicit = resolveStandaloneConfig({ createArtifacts: false, updateRecords: true });
  assert.strictEqual(explicit.gates.updateRecords, true);

  assert.strictEqual(resolveStandaloneConfig().gates.updateRecords, true, 'default stays open');
});
