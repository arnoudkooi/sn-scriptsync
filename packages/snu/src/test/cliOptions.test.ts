import test from 'node:test';
import assert from 'node:assert';
import { parseArgs } from 'util';
import { TOOLS } from '../registry.js';
import { buildParseArgsOptions } from '../cli/index.js';

/**
 * Regression: 0.2.3 built the parseArgs option map with `short: optDef.short`,
 * so every option without a short form carried an explicit `short: undefined`.
 * parseArgs validates `short` whenever the key is present, so those commands
 * threw ERR_INVALID_ARG_TYPE before parsing a single argument — `snu record
 * delete`, `snu browser form`, `snu browser set`, `snu browser action`,
 * `snu browser nav` and `snu screenshot` failed on every invocation.
 */
test('every tool builds a parseArgs option map that parseArgs accepts', () => {
  for (const tool of TOOLS) {
    const options = buildParseArgsOptions(tool);
    assert.doesNotThrow(
      () => parseArgs({ args: [], options, allowPositionals: true, strict: false }),
      `parseArgs rejected the option map for '${tool.cliCommand || tool.name}'`
    );
  }
});

test('an option without a short form omits the key entirely', () => {
  const options = buildParseArgsOptions({
    cliOptions: { confirm: { type: 'boolean' }, value: { type: 'string', short: 'v' } },
  });
  assert.ok(!('short' in options.confirm), 'short must be absent, not undefined');
  assert.strictEqual(options.value.short, 'v');
});

test('short-less flags actually parse', () => {
  const deleteTool = TOOLS.find((t) => t.cliCommand === 'record delete');
  assert.ok(deleteTool, 'record delete tool is registered');
  const parsed = parseArgs({
    args: ['--confirm'],
    options: buildParseArgsOptions(deleteTool!),
    allowPositionals: true,
    strict: false,
  });
  assert.strictEqual(parsed.values.confirm, true);
});

test('an omitted boolean flag stays undefined rather than becoming a string', () => {
  const browserAction = TOOLS.find((t) => t.cliCommand === 'browser action');
  assert.ok(browserAction, 'browser action tool is registered');
  const parsed = parseArgs({
    args: ['save'],
    options: buildParseArgsOptions(browserAction!),
    allowPositionals: true,
    strict: false,
  });
  assert.strictEqual(parsed.values['no-suppress-dialogs'], undefined);
  assert.deepStrictEqual(parsed.positionals, ['save']);
});
