import test from 'node:test';
import assert from 'node:assert';
import { parseArgs } from 'util';
import { TOOLS } from '../registry.js';
import { buildParseArgsOptions, unknownLifecycleOptionError } from '../cli/index.js';

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

test('E_INSTANCE_REQUIRED is rephrased for the --instance flag on the CLI', async () => {
  const { cliInstanceRequiredMessage } = await import('../cli/format.js');
  const err = Object.assign(
    new Error('Multiple known workspace instances found (dev382144, ven08329); this does not mean they have live helper sessions. Pass "instance": "<name>" in the request.'),
    { code: 'E_INSTANCE_REQUIRED', details: { knownInstances: ['dev382144', 'ven08329'], connectedInstances: [] } }
  );
  const msg = cliInstanceRequiredMessage(err, ['query', 'incident', '--json']);
  assert.ok(!msg.includes('in the request'), 'API phrasing must not leak to the terminal');
  assert.ok(msg.includes('--instance'), 'must name the CLI flag');
  assert.ok(msg.includes('snu -i dev382144 query incident'), `must show a runnable example, got: ${msg}`);
  assert.ok(msg.includes('does not mean its helper tab is open'));

  const live = Object.assign(new Error('Multiple helper-connected instances found (a, b). Pass "instance": "<name>" in the request.'), {
    code: 'E_INSTANCE_REQUIRED', details: { knownInstances: ['a', 'b', 'c'], connectedInstances: ['a', 'b'] },
  });
  const liveMsg = cliInstanceRequiredMessage(live, ['record', 'get', 'incident']);
  assert.ok(liveMsg.startsWith('Several instances have a live helper session (a, b).'));
  assert.ok(liveMsg.includes('snu -i a record get'));
});

/**
 * Regression (SNU0000010172): `snu serve --p 1979 --ws 1980` dropped the
 * mistyped `--p` without a word, so the HTTP API stayed on the default port.
 */
test('lifecycle commands reject an option they do not know', () => {
  const message = unknownLifecycleOptionError('serve', ['--p', '1979', '--ws', '1980']);
  assert.ok(message, 'a mistyped flag must be reported');
  assert.match(message!, /--p \(did you mean --port\?\)/);
  assert.match(message!, /Supported: --port, --ws, --force/);
  assert.ok(!/--ws[ ,(]/.test(message!.split('Supported:')[0]), 'known flags are not reported');
});

test('lifecycle commands accept every documented option form', () => {
  assert.strictEqual(unknownLifecycleOptionError('serve', ['--port', '1979', '--ws=1980', '--force']), null);
  assert.strictEqual(unknownLifecycleOptionError('stop', ['--force']), null);
  assert.strictEqual(unknownLifecycleOptionError('status', []), null);
});

test('only lifecycle commands are checked', () => {
  assert.strictEqual(unknownLifecycleOptionError('query', ['incident', '--limit', '5']), null);
});

test('status does not take --force', () => {
  assert.match(unknownLifecycleOptionError('status', ['--force'])!, /--force/);
});
