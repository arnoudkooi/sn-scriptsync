import test from 'node:test';
import assert from 'node:assert';
import {
  mergeMcpConfig,
  setupTargets,
  buildClaudeCodeArgs,
  claudeDesktopConfigPath,
  printableConfig,
  MCP_SERVER_KEY,
  CANONICAL_COMMAND,
  CANONICAL_ARGS,
} from '../cli/setup.js';

test('Setup: mergeMcpConfig creates a config from scratch', () => {
  const { next, changed } = mergeMcpConfig(undefined, 'mcpServers');
  assert.strictEqual(changed, true);
  const parsed = JSON.parse(next);
  assert.deepStrictEqual(parsed.mcpServers[MCP_SERVER_KEY], {
    command: CANONICAL_COMMAND,
    args: CANONICAL_ARGS,
  });
  assert.ok(next.endsWith('\n'));
});

test('Setup: mergeMcpConfig preserves unrelated servers and top-level keys', () => {
  const existing = JSON.stringify({
    theme: 'dark',
    mcpServers: { other: { command: 'foo', args: ['bar'] } },
  });
  const parsed = JSON.parse(mergeMcpConfig(existing, 'mcpServers').next);
  assert.strictEqual(parsed.theme, 'dark');
  assert.deepStrictEqual(parsed.mcpServers.other, { command: 'foo', args: ['bar'] });
  assert.ok(parsed.mcpServers[MCP_SERVER_KEY]);
});

test('Setup: mergeMcpConfig is idempotent', () => {
  const first = mergeMcpConfig(undefined, 'mcpServers');
  const second = mergeMcpConfig(first.next, 'mcpServers');
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.next, first.next);
});

test('Setup: mergeMcpConfig replaces an outdated entry', () => {
  const stale = JSON.stringify({
    mcpServers: { [MCP_SERVER_KEY]: { command: 'npx', args: ['-y', '@snutils/snu', '--mcp'] } },
  });
  const { changed, next } = mergeMcpConfig(stale, 'mcpServers');
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(JSON.parse(next).mcpServers[MCP_SERVER_KEY].args, CANONICAL_ARGS);
});

test('Setup: mergeMcpConfig emits stdio type for the VS Code servers dialect', () => {
  const parsed = JSON.parse(mergeMcpConfig(undefined, 'servers').next);
  assert.strictEqual(parsed.servers[MCP_SERVER_KEY].type, 'stdio');
  assert.strictEqual(parsed.servers[MCP_SERVER_KEY].command, CANONICAL_COMMAND);
});

test('Setup: mergeMcpConfig refuses to clobber a broken config file', () => {
  assert.throws(() => mergeMcpConfig('{ not json', 'mcpServers'), /not valid JSON/);
  assert.throws(() => mergeMcpConfig('[1,2]', 'mcpServers'), /not a JSON object/);
});

test('Setup: claudeDesktopConfigPath resolves per platform', () => {
  assert.match(
    claudeDesktopConfigPath('darwin', '/Users/x'),
    /Library\/Application Support\/Claude\/claude_desktop_config\.json$/
  );
  assert.match(
    claudeDesktopConfigPath('linux', '/home/x'),
    /\.config\/Claude\/claude_desktop_config\.json$/
  );
});

test('Setup: targets honor project scope for cursor and vscode', () => {
  const project = setupTargets({ home: '/Users/x', cwd: '/proj', project: true });
  assert.strictEqual(project.find((t) => t.id === 'cursor')?.configPath, '/proj/.cursor/mcp.json');
  assert.strictEqual(project.find((t) => t.id === 'vscode')?.configPath, '/proj/.vscode/mcp.json');

  const global = setupTargets({ home: '/Users/x', cwd: '/proj' });
  assert.strictEqual(global.find((t) => t.id === 'cursor')?.configPath, '/Users/x/.cursor/mcp.json');
});

test('Setup: claude mcp add args follow the canonical entry', () => {
  assert.deepStrictEqual(buildClaudeCodeArgs(false), [
    'mcp', 'add', '--scope', 'user', MCP_SERVER_KEY, '--', CANONICAL_COMMAND, ...CANONICAL_ARGS,
  ]);
  assert.strictEqual(buildClaudeCodeArgs(true)[3], 'project');
});

test('Setup: printable config contains every dialect and no secrets', () => {
  const text = printableConfig();
  assert.match(text, /mcpServers/);
  assert.match(text, /"servers"/);
  assert.match(text, /claude mcp add/);
  assert.match(text, /CLAUDE\.md/);
  // Static and secret-free: never a token, port number, or localhost URL.
  assert.doesNotMatch(text, /token/i);
  assert.doesNotMatch(text, /127\.0\.0\.1|localhost/);
});
