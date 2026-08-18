import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUpdateNotice, isNewerVersion, shouldCheckForUpdates } from '../cli/updateCheck.js';

test('Update check: compares stable semantic versions', () => {
  assert.strictEqual(isNewerVersion('0.1.6', '0.1.5'), true);
  assert.strictEqual(isNewerVersion('0.1.5', '0.1.5'), false);
  assert.strictEqual(isNewerVersion('0.1.4', '0.1.5'), false);
  assert.strictEqual(isNewerVersion('1.0.0', '0.9.9'), true);
  assert.strictEqual(isNewerVersion('1.0.0', '1.0.0-beta.1'), true);
});

test('Update check: only runs for an interactive online CLI', () => {
  assert.strictEqual(shouldCheckForUpdates({}, true), true);
  assert.strictEqual(shouldCheckForUpdates({}, false), false);
  assert.strictEqual(shouldCheckForUpdates({ CI: '1' }, true), false);
  assert.strictEqual(shouldCheckForUpdates({ SNU_DISABLE_UPDATE_CHECK: '1' }, true), false);
  assert.strictEqual(shouldCheckForUpdates({ npm_config_offline: 'true' }, true), false);
});

test('Update check: notifies once per interval and writes a private cache', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-update-check-'));
  const cacheFile = path.join(tempDir, 'cache.json');
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount++;
    return {
      ok: true,
      async json() {
        return { version: '0.1.6' };
      },
    };
  };

  try {
    const first = await getUpdateNotice({
      currentVersion: '0.1.5',
      cacheFile,
      now: 1_000_000,
      fetchImpl,
    });
    const second = await getUpdateNotice({
      currentVersion: '0.1.5',
      cacheFile,
      now: 1_000_001,
      fetchImpl,
    });

    assert.match(first || '', /v0\.1\.5 -> v0\.1\.6/);
    assert.strictEqual(second, undefined);
    assert.strictEqual(fetchCount, 1);
    assert.strictEqual(fs.statSync(cacheFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Update check: network failures never produce a notice', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-update-check-'));
  const cacheFile = path.join(tempDir, 'cache.json');

  try {
    const notice = await getUpdateNotice({
      currentVersion: '0.1.5',
      cacheFile,
      now: 2_000_000,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    assert.strictEqual(notice, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
