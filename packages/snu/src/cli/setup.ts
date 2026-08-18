/**
 * `snu setup` — write the canonical MCP server entry into detected AI clients
 * (Claude Code, Cursor, Claude Desktop, Windsurf, VS Code).
 *
 * The entry is static and secret-free by design: bridge discovery (port +
 * token) happens at call time via the port file, so the exact same JSON works
 * for every user on every machine and is safe to commit to a repo.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import { ScriptSyncClientError } from '../client.js';
import { outputJson } from './format.js';
import { inspectBridge } from './daemon.js';

export const MCP_SERVER_KEY = 'sn-utils';

/** Same entry the README documents: @latest + --prefer-online so npx does not
 * pin a stale cached build. */
export const CANONICAL_COMMAND = 'npx';
export const CANONICAL_ARGS = ['--yes', '--prefer-online', '@snutils/snu@latest', '--mcp'];

/** Two-line snippet for terminal agents (CLAUDE.md / AGENTS.md). */
export const TERMINAL_AGENT_SNIPPET = [
  'ServiceNow access: the `snu` CLI (npx --yes @snutils/snu@latest) drives ServiceNow through SN Utils ScriptSync.',
  'Run `snu context` first to see the connected instance and permissions, then `snu --help` for commands. Use --json for machine output.',
].join('\n');

export type SetupClientId = 'claude-code' | 'cursor' | 'claude-desktop' | 'windsurf' | 'vscode';

export interface SetupTarget {
  id: SetupClientId;
  label: string;
  kind: 'json' | 'cli';
  /** json kind: config file to merge into. */
  configPath?: string;
  /** json kind: top-level key holding server entries. */
  rootKey?: 'mcpServers' | 'servers';
  /** Existence of this path marks the client as installed. */
  detectPath: string;
}

export interface SetupTargetOptions {
  home?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  project?: boolean;
}

export function claudeDesktopConfigPath(platform: NodeJS.Platform, home: string): string {
  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    default:
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

export function setupTargets(options: SetupTargetOptions = {}): SetupTarget[] {
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const project = options.project === true;
  const desktopPath = claudeDesktopConfigPath(platform, home);

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      kind: 'cli',
      detectPath: path.join(home, '.claude'),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      kind: 'json',
      configPath: project ? path.join(cwd, '.cursor', 'mcp.json') : path.join(home, '.cursor', 'mcp.json'),
      rootKey: 'mcpServers',
      detectPath: path.join(home, '.cursor'),
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      kind: 'json',
      configPath: desktopPath,
      rootKey: 'mcpServers',
      detectPath: path.dirname(desktopPath),
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      kind: 'json',
      configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      rootKey: 'mcpServers',
      detectPath: path.join(home, '.codeium', 'windsurf'),
    },
    {
      id: 'vscode',
      label: 'VS Code (workspace)',
      kind: 'json',
      configPath: path.join(cwd, '.vscode', 'mcp.json'),
      rootKey: 'servers',
      detectPath: path.join(cwd, '.vscode'),
    },
  ];
}

export function buildClaudeCodeArgs(projectScope: boolean): string[] {
  return ['mcp', 'add', '--scope', projectScope ? 'project' : 'user', MCP_SERVER_KEY, '--', CANONICAL_COMMAND, ...CANONICAL_ARGS];
}

export interface MergeResult {
  next: string;
  changed: boolean;
}

/**
 * Merge the canonical entry into an MCP config file's text. Never touches
 * other keys; throws on unparseable JSON so a broken config is surfaced
 * instead of clobbered. Idempotent: re-running produces no change.
 */
export function mergeMcpConfig(existingText: string | undefined, rootKey: 'mcpServers' | 'servers'): MergeResult {
  let config: any = {};
  if (existingText && existingText.trim()) {
    try {
      config = JSON.parse(existingText);
    } catch {
      throw new ScriptSyncClientError('Existing config is not valid JSON; fix or remove it, then re-run setup.', 'E_INVALID_CONFIG');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new ScriptSyncClientError('Existing config is not a JSON object; fix or remove it, then re-run setup.', 'E_INVALID_CONFIG');
    }
  }
  if (!config[rootKey] || typeof config[rootKey] !== 'object') config[rootKey] = {};

  // VS Code's mcp.json dialect declares stdio explicitly; mcpServers infers it.
  const entry: Record<string, unknown> =
    rootKey === 'servers'
      ? { type: 'stdio', command: CANONICAL_COMMAND, args: [...CANONICAL_ARGS] }
      : { command: CANONICAL_COMMAND, args: [...CANONICAL_ARGS] };

  const changed = JSON.stringify(config[rootKey][MCP_SERVER_KEY]) !== JSON.stringify(entry);
  config[rootKey][MCP_SERVER_KEY] = entry;

  return { next: `${JSON.stringify(config, null, 2)}\n`, changed };
}

export function printableConfig(): string {
  const mcpServersBlock = JSON.stringify(
    { mcpServers: { [MCP_SERVER_KEY]: { command: CANONICAL_COMMAND, args: [...CANONICAL_ARGS] } } },
    null,
    2
  );
  const vscodeBlock = JSON.stringify(
    { servers: { [MCP_SERVER_KEY]: { type: 'stdio', command: CANONICAL_COMMAND, args: [...CANONICAL_ARGS] } } },
    null,
    2
  );
  return [
    'MCP configuration for Cursor, Claude Desktop, and Windsurf (mcpServers dialect):',
    '',
    mcpServersBlock,
    '',
    'VS Code .vscode/mcp.json (servers dialect):',
    '',
    vscodeBlock,
    '',
    'Claude Code:',
    '',
    `  claude mcp add --scope user ${MCP_SERVER_KEY} -- ${CANONICAL_COMMAND} ${CANONICAL_ARGS.join(' ')}`,
    '',
    'Terminal agents (append to CLAUDE.md / AGENTS.md):',
    '',
    TERMINAL_AGENT_SNIPPET,
    '',
  ].join('\n');
}

export interface SetupFlags {
  client?: string;
  project?: boolean;
  print?: boolean;
  yes?: boolean;
  json?: boolean;
  portFile?: string;
}

interface AppliedResult {
  client: SetupClientId;
  label: string;
  changed: boolean;
  detail: string;
}

function hasBinary(name: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    return spawnSync(probe, [name], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function detect(target: SetupTarget): boolean {
  if (target.kind === 'cli') return hasBinary('claude') || fs.existsSync(target.detectPath);
  return fs.existsSync(target.detectPath);
}

function applyJsonTarget(target: SetupTarget): AppliedResult {
  const configPath = target.configPath as string;
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : undefined;
  const merged = mergeMcpConfig(existing, target.rootKey as 'mcpServers' | 'servers');
  if (merged.changed) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, merged.next, 'utf8');
  }
  return {
    client: target.id,
    label: target.label,
    changed: merged.changed,
    detail: merged.changed ? `added "${MCP_SERVER_KEY}" to ${configPath}` : `already configured in ${configPath}`,
  };
}

function applyClaudeCodeTarget(target: SetupTarget, projectScope: boolean): AppliedResult {
  if (!hasBinary('claude')) {
    throw new ScriptSyncClientError('`claude` CLI not found on PATH. Install Claude Code first, or use `snu setup --print`.', 'E_CLIENT_NOT_FOUND');
  }
  const res = spawnSync('claude', buildClaudeCodeArgs(projectScope), { encoding: 'utf8' });
  if (res.status === 0) {
    return {
      client: target.id,
      label: target.label,
      changed: true,
      detail: `registered via \`claude mcp add\` (${projectScope ? 'project' : 'user'} scope)`,
    };
  }
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  if (/already exists/i.test(output)) {
    return { client: target.id, label: target.label, changed: false, detail: 'already registered with Claude Code' };
  }
  throw new ScriptSyncClientError(`\`claude mcp add\` failed: ${output.trim() || `exit ${res.status}`}`, 'E_CLIENT_SETUP_FAILED');
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

/** Finish with a live bridge check so a successful setup ends in proof. */
async function verifyBridge(flags: SetupFlags): Promise<{ running: boolean; browserHint?: string }> {
  try {
    const status = await inspectBridge({ portFile: flags.portFile, cwd: process.cwd() });
    return { running: status.running === true };
  } catch {
    return { running: false };
  }
}

export async function runSetup(flags: SetupFlags): Promise<void> {
  if (flags.print) {
    process.stdout.write(printableConfig());
    return;
  }

  const targets = setupTargets({ project: flags.project });

  let selected: SetupTarget[];
  if (flags.client) {
    const target = targets.find((t) => t.id === flags.client);
    if (!target) {
      throw new ScriptSyncClientError(
        `Unknown client "${flags.client}". Supported: ${targets.map((t) => t.id).join(', ')}`,
        'E_INVALID_PARAMS'
      );
    }
    selected = [target];
  } else {
    // The workspace .vscode/mcp.json is opt-in via --client vscode: writing
    // into the current folder unasked is surprising.
    selected = targets.filter((t) => t.id !== 'vscode' && detect(t));
    if (selected.length === 0) {
      throw new ScriptSyncClientError(
        'No supported MCP clients detected (Claude Code, Cursor, Claude Desktop, Windsurf).\n' +
          'Use `snu setup --client <name>` to force one, or `snu setup --print` for copy-paste config.',
        'E_CLIENT_NOT_FOUND'
      );
    }
  }

  if (!flags.yes && !flags.client) {
    if (!process.stdin.isTTY || flags.json) {
      throw new ScriptSyncClientError(
        `Detected: ${selected.map((t) => t.label).join(', ')}. ` +
          'Non-interactive session: re-run with --yes to configure all detected clients, or --client <name> for one.',
        'E_CONFIRM_REQUIRED'
      );
    }
    const answer = await ask(`Configure the SN Utils MCP server for: \x1b[1m${selected.map((t) => t.label).join(', ')}\x1b[0m? [Y/n] `);
    if (answer.trim() !== '' && !/^y(es)?$/i.test(answer.trim())) {
      process.stderr.write('Aborted. Nothing was written.\n');
      return;
    }
  }

  const applied: AppliedResult[] = [];
  const errors: Array<{ client: string; error: string }> = [];
  for (const target of selected) {
    try {
      applied.push(target.kind === 'json' ? applyJsonTarget(target) : applyClaudeCodeTarget(target, flags.project === true));
    } catch (err: any) {
      errors.push({ client: target.id, error: err?.message || String(err) });
    }
  }

  const bridge = await verifyBridge(flags);

  if (flags.json) {
    outputJson({ configured: applied, errors, bridgeRunning: bridge.running });
  } else {
    for (const result of applied) {
      process.stdout.write(`\x1b[32m✓\x1b[0m ${result.label}: ${result.detail}\n`);
    }
    for (const failure of errors) {
      process.stderr.write(`\x1b[31m✗\x1b[0m ${failure.client}: ${failure.error}\n`);
    }
    if (bridge.running) {
      process.stdout.write(`\n\x1b[32m✓\x1b[0m Bridge check: SN Utils bridge is active. Run \`snu context\` for the full picture.\n`);
    } else {
      process.stdout.write(
        `\n\x1b[33m•\x1b[0m Setup written, but no bridge is running right now.\n` +
          `  Open VS Code with sn-scriptsync (or run \`snu serve\`), then run /token in a ServiceNow browser tab.\n`
      );
    }
  }

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
