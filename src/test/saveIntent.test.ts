import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExplicitSaveIntents, decideEditorSave, filesForSync, intentIncludesHeld } from '../saveIntent';

test('Save & Sync shortcuts require focus in the editor, not just an active file', () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
  for (const command of ['extension.saveAndSync', 'extension.saveWithoutFormattingAndSync']) {
    const bindings = manifest.contributes.keybindings.filter(binding => binding.command === command);
    assert.ok(bindings.length, `${command} has a shortcut`);
    for (const binding of bindings) {
      const contexts = binding.when.split(/\s*&&\s*/);
      assert.ok(contexts.includes('editorTextFocus'), `${command} must not override Save in the terminal, search or Explorer`);
      assert.ok(contexts.includes('config.sn-scriptsync.save.pushOnSaveShortcut'), `${command} respects local-only saves`);
    }
  }
});

/**
 * A save pushes only when Save & Sync (Ctrl+S / Cmd+S in that file) marked it.
 * Save All, refactoring auto-save and other extensions' saves all report as
 * Manual in VS Code (scripts/test-save-paths.mjs), so they are held instead.
 */

test('save decision: only a marked save of a synced file pushes', () => {
  assert.strictEqual(decideEditorSave({ syncable: true, reviewStaged: false, explicit: true }), 'push');
  assert.strictEqual(decideEditorSave({ syncable: true, reviewStaged: false, explicit: false }), 'queue_held');
  assert.strictEqual(decideEditorSave({ syncable: false, reviewStaged: false, explicit: true }), 'ignore');
  assert.strictEqual(decideEditorSave({ syncable: false, reviewStaged: false, explicit: false }), 'ignore');
});

test('save decision: a staged review file stays held even with Ctrl+S', () => {
  assert.strictEqual(decideEditorSave({ syncable: true, reviewStaged: true, explicit: true }), 'hold_review');
  assert.strictEqual(decideEditorSave({ syncable: true, reviewStaged: true, explicit: false }), 'hold_review');
});

test('rename across files: one marked file pushes, the rest are held', () => {
  const intents = new ExplicitSaveIntents();
  intents.mark('a1.js');
  const files = ['a2.js', 'a1.js', 'a3.js', 'b1.js', 'b2.js'];
  const decisions = files.map(f => decideEditorSave({ syncable: true, reviewStaged: false, explicit: intents.take(f) }));
  assert.deepStrictEqual(decisions, ['queue_held', 'push', 'queue_held', 'queue_held', 'queue_held']);
});

test('explicit marks are one-shot', () => {
  const intents = new ExplicitSaveIntents();
  intents.mark('a.js');
  assert.strictEqual(intents.has('a.js'), true);
  assert.strictEqual(intents.take('a.js'), true);
  assert.strictEqual(intents.take('a.js'), false, 'a second save of the same file is not explicit');
  assert.strictEqual(intents.take('never-marked.js'), false);
});

test('explicit marks expire', () => {
  let now = 1_000;
  const intents = new ExplicitSaveIntents(30_000, () => now);
  intents.mark('a.js');
  now += 30_001;
  assert.strictEqual(intents.has('a.js'), false);
  assert.strictEqual(intents.take('a.js'), false);
  intents.mark('b.js');
  intents.clear('b.js');
  assert.strictEqual(intents.take('b.js'), false);
});

test('queue: only a user sync pushes held saves', () => {
  const pending = new Set(['held.js', 'external.js', 'review.js']);
  const held = (f: string) => f === 'held.js' || f === 'review.js';
  assert.deepStrictEqual(filesForSync(pending, 'queue_sync', held), ['held.js', 'external.js', 'review.js']);
  assert.deepStrictEqual(filesForSync(pending, 'queue_auto_sync', held), ['external.js']);
  assert.deepStrictEqual(filesForSync(pending, 'agent_sync', held), ['external.js']);
  assert.strictEqual(intentIncludesHeld('save_command'), false);
});
