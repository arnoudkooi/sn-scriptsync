import { parseArgs } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { TOOLS, getToolByCliCommand } from '../registry.js';
import { ScriptSyncClient, ScriptSyncClientError, checkHealth } from '../client.js';
import { HealthResponse } from '../types.js';
import { resolveContentInput } from './stdin.js';
import { formatHumanOutput, outputJson, outputError } from './format.js';
import { startMcpServer } from '../mcp/index.js';
import { StandaloneBridge } from '../server/standalone.js';
import { getUpdateNotice, shouldCheckForUpdates } from './updateCheck.js';
import {
  inspectBridge,
  requestStandaloneYield,
  waitForBridgeExit,
  requestEditorBridgeLifecycle,
  waitForBridgeUnreachable,
  waitForBridgeReachable,
} from './daemon.js';
import { findPortListener, reclaimPort, terminateListener, classifyListener, ReclaimResult, PortListener } from './portReclaim.js';
import { checkForCliUpdate, installLatestWithNpm } from './selfUpdate.js';
import { runSetup } from './setup.js';

const packageMetadata = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
) as { version: string };

export const VERSION = packageMetadata.version;

function startUpdateCheck(enabled: boolean): Promise<string | undefined> {
  if (!enabled || !shouldCheckForUpdates()) return Promise.resolve(undefined);
  return getUpdateNotice({ currentVersion: VERSION });
}

async function printUpdateNotice(noticePromise: Promise<string | undefined>): Promise<void> {
  const notice = await noticePromise;
  if (notice) process.stderr.write(notice);
}

export type ParseArgsOptions = Record<string, { type: 'string' | 'boolean'; short?: string }>;

/**
 * Build the `parseArgs` option map for a tool: the global options every command
 * accepts, plus the tool's own `cliOptions`.
 *
 * `short` must be OMITTED for an option that has no short form, never set to
 * `undefined`. parseArgs validates the property whenever the key is present
 * (it checks with ObjectHasOwn), so `short: undefined` throws
 * ERR_INVALID_ARG_TYPE before a single argument is read — which took out every
 * invocation of `record delete`, `browser form`, `browser set`, `browser
 * action`, `browser nav` and `screenshot` in 0.2.3, whether or not the flag was
 * passed. Exported so the regression test exercises this builder rather than a
 * copy of it.
 */
export function buildParseArgsOptions(tool: { cliOptions?: Record<string, { type: 'string' | 'boolean'; short?: string }> }): ParseArgsOptions {
  const optionsConfig: ParseArgsOptions = {
    json: { type: 'boolean', short: 'j' },
    instance: { type: 'string', short: 'i' },
    'port-file': { type: 'string' },
  };

  if (tool.cliOptions) {
    for (const [optName, optDef] of Object.entries(tool.cliOptions)) {
      optionsConfig[optName] = optDef.short
        ? { type: optDef.type, short: optDef.short }
        : { type: optDef.type };
    }
  }

  return optionsConfig;
}

export function printHelp(): void {
  console.log(`
\x1b[1mSN Utils CLI (snu)\x1b[0m — Unified CLI and MCP Bridge for ServiceNow

\x1b[1mUSAGE:\x1b[0m
  snu <command> [arguments...] [options...]
  snu --mcp                           Start Model Context Protocol (MCP) server on stdio
  snu serve [--port <p>] [--ws <p>]   Start persistent standalone bridge daemon
  snu status                          Show the active local bridge process
  snu restart [--force]               Replace a standalone bridge (reclaims a stuck port)
  snu stop [--force]                  Stop a standalone bridge, even an orphaned one holding port 1978
  snu update [--check]                Check for or install the latest CLI release
  snu setup [options]                 Configure AI clients (Claude Code, Cursor, ...) to use the MCP server

\x1b[1mCORE COMMANDS:\x1b[0m
  context                             Show active connection, helper tab, and instance roster
  search <term>                       Fast GraphQL code search across script tables (Pro)
  schema <table>                      Inspect table columns, types, references, and choices
  query <table> [query]               Query records with encoded query and field projections
  run [script]                        Execute server-side Background Script and capture output

\x1b[1mRECORD & ARTIFACT COMMANDS:\x1b[0m
  record get <table> <sys_id>         Fetch a record by sys_id
  record create <table> [f=v ...]     Create a data row (incident, task, user) via the REST API
  record update <table> <sys_id> <f>  Update a record field (--value <v>, --file <p>, or stdin)
  record delete <table> <sys_id>      Delete a record (--confirm or --dry-run)
  artifact create <table> <name>      Create a scriptable artifact (Script Include, etc.)
  rest <endpoint>                     Call any REST endpoint (--method, --body, --query)

\x1b[1mBROWSER COMMANDS:\x1b[0m
  browser form                        Read live form table, sys_id, and fields via g_form
  browser set <field> <value>         Set live form field value via g_form.setValue
  browser action <action>             Trigger form UI action (e.g. save, sysverb_update)
  browser nav <url>                   Navigate connected tab to URL and wait for load
  screenshot                          Capture viewport screenshot of active tab

\x1b[1mSETUP OPTIONS:\x1b[0m
  --client <name>                     One of: claude-code, cursor, claude-desktop, windsurf, vscode
  --project                           Write project-scoped config (cursor, vscode, claude-code)
  --print                             Print copy-paste config blocks instead of writing files
  -y, --yes                           Skip the confirmation prompt

\x1b[1mGLOBAL OPTIONS:\x1b[0m
  -j, --json                          Output strict JSON on stdout for scripting/agents
  -i, --instance <name>               Target specific instance folder
  --port-file <path>                  Explicit path to sn-agent-port.json
  -h, --help                          Show help
  -v, --version                       Show version
`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  // Check for MCP server trigger first
  if (argv.includes('--mcp')) {
    await startMcpServer();
    return;
  }

  if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
    printHelp();
    await printUpdateNotice(startUpdateCheck(true));
    return;
  }

  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(`snu v${VERSION}`);
    await printUpdateNotice(startUpdateCheck(true));
    return;
  }

  let isJsonMode = argv.includes('-j') || argv.includes('--json');
  let instance: string | undefined;
  let portFile: string | undefined;

  // Extract global options and identify the command tokens
  const nonGlobalTokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-j' || arg === '--json') {
      isJsonMode = true;
    } else if (arg === '-i' || arg === '--instance') {
      instance = argv[++i];
    } else if (arg.startsWith('--instance=')) {
      instance = arg.slice('--instance='.length);
    } else if (arg === '--port-file') {
      portFile = argv[++i];
    } else if (arg.startsWith('--port-file=')) {
      portFile = arg.slice('--port-file='.length);
    } else {
      nonGlobalTokens.push(arg);
    }
  }

  if (nonGlobalTokens.length === 0) {
    printHelp();
    await printUpdateNotice(startUpdateCheck(!isJsonMode));
    return;
  }

  const lifecycleCommand = nonGlobalTokens[0];
  const updateNotice = startUpdateCheck(!isJsonMode && lifecycleCommand !== 'update');

  const lifecycleArgs = parseArgs({
    args: nonGlobalTokens.slice(1),
    options: {
      port: { type: 'string' },
      ws: { type: 'string' },
      check: { type: 'boolean' },
      force: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });
  const lifecycleValues = lifecycleArgs.values as Record<string, string | boolean | undefined>;
  const parsePort = (name: 'port' | 'ws', fallback: number): number => {
    const raw = lifecycleValues[name];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new ScriptSyncClientError(`Invalid --${name} value: ${raw}`, 'E_INVALID_PARAMS');
    }
    return parsed;
  };

  const startStandalone = async (): Promise<void> => {
    const standalone = new StandaloneBridge({
      cwd: process.cwd(),
      httpPort: parsePort('port', 1977),
      wsPort: parsePort('ws', 1978),
      onYield: () => {
        console.log('\n[snu] Standalone bridge stopped.');
        process.exit(0);
      },
    });

    const { httpPort, wsPort } = await standalone.start();
    if (isJsonMode) {
      outputJson({ running: true, hostKind: 'standalone', pid: process.pid, httpPort, wsPort });
    } else {
      console.log(`\n\x1b[1m\x1b[32m[snu] Standalone Bridge Active\x1b[0m`);
      console.log(`  • PID:         ${process.pid}`);
      console.log(`  • HTTP API:    http://127.0.0.1:${httpPort}/api`);
      console.log(`  • WebSocket:   ws://127.0.0.1:${wsPort} (connect via SN Utils helper tab)`);
      console.log(`\n\x1b[90mRunning standalone. Press Ctrl+C to stop.\x1b[0m\n`);
    }
    await printUpdateNotice(updateNotice);
  };

  // Standalone bridge lifecycle commands.
  if (['serve', 'status', 'stop', 'restart'].includes(lifecycleCommand)) {
    const forceReclaim = lifecycleValues.force === true;
    // Named rather than positional: the orphan probe below needs the HTTP port
    // specifically, and reading it as bridgePorts[1] silently probed the wrong
    // port if the array literal was ever reordered.
    let ports = { ws: 1978, http: 1977 };
    let bridgePorts: number[] = [ports.ws, ports.http];

    const describeListener = (l: PortListener): string => {
      const cmd = (l.command || '').trim();
      const shortCmd = cmd.length > 90 ? `${cmd.slice(0, 87)}...` : cmd;
      return `PID ${l.pid}${shortCmd ? ` (${shortCmd})` : ''}`;
    };

    const explainBlocked = (port: number, result: ReclaimResult): ScriptSyncClientError => {
      const who = result.listener ? describeListener(result.listener) : 'an unknown process';
      if (result.status === 'refused_vscode') {
        return new ScriptSyncClientError(
          `Port ${port} is held by a ScriptSync bridge inside VS Code (${who}). Stop it from the sn-scriptsync status bar in VS Code instead.`,
          'E_NOT_STANDALONE'
        );
      }
      if (result.status === 'refused_foreign') {
        return new ScriptSyncClientError(
          `Port ${port} is held by ${who}, which does not look like an snu bridge. Re-run with --force to stop it anyway.`,
          'E_PORT_BUSY'
        );
      }
      return new ScriptSyncClientError(`Could not free port ${port}: ${who} did not stop.`, 'E_STOP_FAILED');
    };

    // Free the bridge ports from ground truth. Port-file discovery can miss a
    // live bridge (deleted or clobbered port file — e.g. an MCP host spawned
    // `snu --mcp` and something else removed the global port file), which used
    // to leave `snu stop` claiming "already stopped" while the port stayed
    // bound.
    const reclaimBridgePorts = async (): Promise<{
      reclaimed: PortListener[];
      blocked?: { port: number; result: ReclaimResult };
    }> => {
      const reclaimed: PortListener[] = [];
      const seenPids = new Set<number>();
      for (const port of bridgePorts) {
        const result = await reclaimPort(port, { force: forceReclaim });
        if (result.status === 'free') continue;
        if (result.status === 'reclaimed') {
          if (result.listener && !seenPids.has(result.listener.pid)) {
            seenPids.add(result.listener.pid);
            reclaimed.push(result.listener);
          }
          continue;
        }
        return { reclaimed, blocked: { port, result } };
      }
      return { reclaimed };
    };

    try {
      ports = { ws: parsePort('ws', 1978), http: parsePort('port', 1977) };
      bridgePorts = [ports.ws, ports.http];
      const status = await inspectBridge({ portFile, cwd: process.cwd() });

      if (lifecycleCommand === 'status') {
        let orphan: PortListener | null = null;
        let orphanKind: ReturnType<typeof classifyListener> | undefined;
        let orphanHealth: HealthResponse | null = null;
        if (!status.running) {
          for (const port of bridgePorts) {
            orphan = await findPortListener(port);
            if (orphan) break;
          }
          if (orphan) {
            orphanKind = classifyListener(orphan.command);
            // A VS Code-hosted bridge can be perfectly healthy while its
            // discovery file is missing (an older ScriptSync build in another
            // editor window deletes it). /api/health needs no token — probe
            // the fixed HTTP port so the advice matches reality.
            const httpPort = ports.http;
            try {
              orphanHealth = await checkHealth(httpPort);
            } catch {
              orphanHealth = null;
            }
          }
        }
        const result = status.running
          ? {
              running: true,
              hostKind: status.health.hostKind || 'unknown',
              pid: status.health.pid,
              httpPort: status.discovery.port,
              apiVersion: status.health.apiVersion,
            }
          : orphan
          ? {
              running: false,
              orphanListener: { pid: orphan.pid, command: orphan.command },
              orphanKind,
              bridgeHealthy: orphanHealth !== null,
            }
          : { running: false };
        if (isJsonMode) outputJson(result);
        else if (status.running) {
          console.log(`\nSN Utils Bridge: active`);
          console.log(`  Host:      ${status.health.hostKind || 'unknown'}`);
          console.log(`  PID:       ${status.health.pid}`);
          console.log(`  HTTP API:  http://127.0.0.1:${status.discovery.port}/api\n`);
        } else if (orphan && orphanKind === 'vscode' && orphanHealth) {
          console.log('\nSN Utils Bridge: healthy, but not discoverable (its port file is missing).');
          console.log('A ScriptSync bridge is running inside a VS Code-family editor:');
          console.log(`  ${describeListener(orphan)}`);
          console.log('To re-register it, reload the SN Utils helper tab in the browser, or toggle');
          console.log('ScriptSync off and on in that editor window. If a second editor window also');
          console.log('runs ScriptSync, update the extension there — older builds delete this file.\n');
        } else if (orphan && orphanKind === 'vscode') {
          console.log('\nSN Utils Bridge: not discoverable. A VS Code-family editor holds the bridge');
          console.log('port but is not answering:');
          console.log(`  ${describeListener(orphan)}`);
          console.log('Toggle ScriptSync off and on in that editor window (`snu stop` will not');
          console.log('touch an editor-hosted bridge).\n');
        } else if (orphan) {
          console.log('\nSN Utils Bridge: not discoverable, but a bridge port is still held by');
          console.log(`  ${describeListener(orphan)}`);
          console.log('Run `snu stop` to reclaim it.\n');
        } else {
          console.log('\nSN Utils Bridge: not running\n');
        }
        await printUpdateNotice(updateNotice);
        return;
      }

      if (lifecycleCommand === 'serve' && status.running) {
        if (isJsonMode) {
          outputJson({ running: true, alreadyRunning: true, hostKind: status.health.hostKind, pid: status.health.pid });
        } else if (status.health.hostKind === 'standalone') {
          console.log(`\nSN Utils standalone bridge is already active (PID ${status.health.pid}).`);
          console.log('Use `snu restart` to replace it.\n');
        } else {
          console.log(`\nScriptSync bridge is active in VS Code (PID ${status.health.pid}).`);
          console.log('A separate standalone bridge is not needed.\n');
        }
        await printUpdateNotice(updateNotice);
        return;
      }

      // Graceful stop of a discovered standalone bridge, escalating to a
      // process-level stop when the yield request fails or times out.
      const stopDiscoveredBridge = async (): Promise<number> => {
        const pid = status.running ? status.discovery.pid : 0;
        if (!status.running) return pid;
        try {
          await requestStandaloneYield(status);
          await waitForBridgeExit(pid);
        } catch (err: any) {
          if (err?.code === 'E_NOT_STANDALONE') throw err; // VS Code owns it — never kill.
          const stopped = await terminateListener(pid, status.discovery.port);
          if (!stopped) throw err;
        }
        return pid;
      };

      // An editor-hosted bridge is no longer a dead end: ask the owning window
      // to stand down or cycle itself. No signal is ever sent to an editor
      // process — that was the manual step this replaces.
      if ((lifecycleCommand === 'stop' || lifecycleCommand === 'restart') && status.running && status.health.hostKind === 'vscode') {
        const editorLabel = status.health.extensionVersion
          ? `sn-scriptsync ${status.health.extensionVersion}`
          : 'the editor-hosted bridge';
        if (lifecycleCommand === 'stop') {
          await requestEditorBridgeLifecycle(status, 'yield');
          await waitForBridgeUnreachable(status.discovery.port);
          if (isJsonMode) {
            outputJson({ stopped: true, hostKind: 'vscode', pid: status.health.pid });
          } else {
            console.log(`\nAsked ${editorLabel} (PID ${status.health.pid}) to release the bridge ports.`);
            console.log('Click sn-scriptsync in that editor window to start it again.\n');
          }
          return;
        }
        const previousPid = status.health.pid;
        await requestEditorBridgeLifecycle(status, 'restart');
        await waitForBridgeUnreachable(status.discovery.port);
        const health = await waitForBridgeReachable(status.discovery.port);
        if (isJsonMode) {
          outputJson({
            restarted: true,
            hostKind: 'vscode',
            previousPid,
            pid: health.pid,
            workspaceRoot: health.workspaceRoot,
            extensionVersion: health.extensionVersion,
          });
        } else {
          console.log(`\nRestarted ${editorLabel}.`);
          console.log(`  Host:      ${health.hostKind || 'vscode'}`);
          console.log(`  PID:       ${health.pid}${health.pid === previousPid ? ' (same extension host)' : ''}`);
          console.log(`  HTTP API:  http://127.0.0.1:${status.discovery.port}/api\n`);
        }
        return;
      }

      if (lifecycleCommand === 'stop') {
        if (!status.running) {
          const { reclaimed, blocked } = await reclaimBridgePorts();
          if (reclaimed.length && !isJsonMode) {
            console.log('\nStopped a bridge that was holding the port without a valid port file:');
            reclaimed.forEach((l) => console.log(`  ${describeListener(l)}`));
            console.log('');
          }
          if (blocked) throw explainBlocked(blocked.port, blocked.result);
          if (isJsonMode) {
            if (reclaimed.length) outputJson({ stopped: true, reclaimedPids: reclaimed.map((l) => l.pid) });
            else outputJson({ stopped: false, alreadyStopped: true });
          } else if (!reclaimed.length) {
            console.log('\nSN Utils standalone bridge is already stopped.\n');
          }
          return;
        }
        const pid = await stopDiscoveredBridge();
        // The discovered bridge is down; sweep for any second orphan still
        // holding a port (e.g. discovery found HTTP but the WS port belongs
        // to an older instance).
        await reclaimBridgePorts();
        if (isJsonMode) outputJson({ stopped: true, pid });
        else console.log(`\nStopped SN Utils standalone bridge (PID ${pid}).\n`);
        return;
      }

      if (lifecycleCommand === 'restart' && status.running) {
        const pid = await stopDiscoveredBridge();
        if (!isJsonMode) console.log(`\nStopped SN Utils standalone bridge (PID ${pid}). Restarting...`);
      }

      // serve / restart: make sure the ports are actually free before binding,
      // even when discovery saw nothing.
      const { reclaimed, blocked } = await reclaimBridgePorts();
      if (reclaimed.length && !isJsonMode) {
        reclaimed.forEach((l) => console.log(`\nStopped orphaned bridge ${describeListener(l)} to free the port.`));
      }
      if (blocked) throw explainBlocked(blocked.port, blocked.result);

      await startStandalone();
    } catch (err: any) {
      outputError(err, isJsonMode);
      process.exit(1);
    }
    return;
  }

  if (lifecycleCommand === 'setup') {
    try {
      const setupArgs = parseArgs({
        args: nonGlobalTokens.slice(1),
        options: {
          client: { type: 'string' },
          project: { type: 'boolean' },
          print: { type: 'boolean' },
          yes: { type: 'boolean', short: 'y' },
        },
        allowPositionals: false,
        strict: false,
      });
      const setupValues = setupArgs.values as Record<string, string | boolean | undefined>;
      await runSetup({
        client: setupValues.client as string | undefined,
        project: setupValues.project === true,
        print: setupValues.print === true,
        yes: setupValues.yes === true,
        json: isJsonMode,
        portFile,
      });
      await printUpdateNotice(updateNotice);
    } catch (err: any) {
      outputError(err, isJsonMode);
      process.exit(1);
    }
    return;
  }

  if (lifecycleCommand === 'update') {
    try {
      const checkOnly = lifecycleValues.check === true;
      if (isJsonMode && !checkOnly) {
        throw new ScriptSyncClientError('Use `snu update --check --json` for machine-readable output.', 'E_INVALID_PARAMS');
      }
      const decision = await checkForCliUpdate(VERSION);
      if (isJsonMode) {
        outputJson(decision);
        return;
      }
      if (decision.action === 'current') {
        console.log(`\nsnu v${VERSION} is already current (npm latest: v${decision.latestVersion}).\n`);
        return;
      }
      if (decision.action === 'npx') {
        console.log(`\nA newer release is available: v${decision.latestVersion}.`);
        console.log('This command is running through npx; restart it with `@snutils/snu@latest`.\n');
        return;
      }
      if (checkOnly) {
        console.log(`\nUpdate available: snu v${VERSION} -> v${decision.latestVersion}`);
        console.log('Run `snu update` to install it.\n');
        return;
      }
      console.log(`\nUpdating snu v${VERSION} -> v${decision.latestVersion}...\n`);
      await installLatestWithNpm();
      console.log(`\nUpdated @snutils/snu to v${decision.latestVersion}.`);
      console.log('If a standalone bridge is active, run `snu restart` to use the new version.\n');
    } catch (err: any) {
      outputError(err, isJsonMode);
      process.exit(1);
    }
    return;
  }

  try {
    // 1. Check for 2-word command matches (e.g. "record get", "artifact create", "browser form")
    let tool = nonGlobalTokens.length >= 2 ? getToolByCliCommand(`${nonGlobalTokens[0]} ${nonGlobalTokens[1]}`) : undefined;
    let commandArgOffset = tool ? 2 : 1;

    // 2. If not matched, check 1-word command matches (e.g. "search", "query", "schema", "context")
    if (!tool) {
      tool = getToolByCliCommand(nonGlobalTokens[0]);
    }

    if (!tool) {
      throw new ScriptSyncClientError(`Unknown command: ${nonGlobalTokens.join(' ')}. Run 'snu --help' for usage.`, 'E_UNKNOWN_COMMAND');
    }

    const commandArgs = nonGlobalTokens.slice(commandArgOffset);

    const optionsConfig = buildParseArgsOptions(tool);

    const parsed = parseArgs({
      args: commandArgs,
      options: optionsConfig,
      allowPositionals: true,
      strict: false,
    });

    const positionals = parsed.positionals;
    const values = parsed.values as Record<string, any>;

    const inputData: Record<string, any> = {
      instance: instance || values.instance,
      ...values,
    };

    // Subcommand-specific positional argument mapping & validation
    switch (tool.cliCommand) {
      case 'context':
        break;

      case 'search':
        if (!positionals[0]) throw new ScriptSyncClientError('Missing required search term: snu search <term>', 'E_INVALID_PARAMS');
        inputData.term = positionals.join(' ');
        break;

      case 'schema':
        if (!positionals[0]) throw new ScriptSyncClientError('Missing required table: snu schema <table>', 'E_INVALID_PARAMS');
        inputData.table = positionals[0];
        break;

      case 'query':
        if (!positionals[0]) throw new ScriptSyncClientError('Missing required table: snu query <table> [query]', 'E_INVALID_PARAMS');
        inputData.table = positionals[0];
        inputData.query = positionals.slice(1).join(' ') || values.query;
        break;

      case 'record get':
        if (!positionals[0] || !positionals[1]) {
          throw new ScriptSyncClientError('Usage: snu record get <table> <sys_id>', 'E_INVALID_PARAMS');
        }
        inputData.table = positionals[0];
        inputData.sys_id = positionals[1];
        break;

      case 'artifact create':
        if (!positionals[0] || !positionals[1]) {
          throw new ScriptSyncClientError('Usage: snu artifact create <table> <name>', 'E_INVALID_PARAMS');
        }
        inputData.table = positionals[0];
        inputData.name = positionals[1];
        break;

      case 'record create': {
        if (!positionals[0]) {
          throw new ScriptSyncClientError('Usage: snu record create <table> [field=value ...] [--fields <json>]', 'E_INVALID_PARAMS');
        }
        inputData.table = positionals[0];
        const fields: Record<string, any> = {};
        if (values.fields) {
          try {
            Object.assign(fields, JSON.parse(String(values.fields)));
          } catch (e: any) {
            throw new ScriptSyncClientError(`--fields is not valid JSON: ${e?.message || e}`, 'E_INVALID_PARAMS');
          }
        }
        for (const token of positionals.slice(1)) {
          const eqIdx = token.indexOf('=');
          if (eqIdx <= 0) {
            throw new ScriptSyncClientError(`Invalid field token '${token}'. Expected field=value.`, 'E_INVALID_PARAMS');
          }
          fields[token.slice(0, eqIdx)] = token.slice(eqIdx + 1);
        }
        if (Object.keys(fields).length === 0) {
          throw new ScriptSyncClientError('No field values given: pass field=value pairs or --fields <json>', 'E_INVALID_PARAMS');
        }
        inputData.fields = fields;
        break;
      }

      case 'rest':
        if (!positionals[0]) {
          throw new ScriptSyncClientError("Usage: snu rest <endpoint> [--method <M>] [--body <json>] [--query <k=v,k=v>]", 'E_INVALID_PARAMS');
        }
        inputData.endpoint = positionals[0];
        if (values.method) inputData.method = String(values.method);
        if (values.body !== undefined) inputData.body = values.body;
        if (values.query !== undefined) inputData.queryParams = values.query;
        break;

      case 'record update':
        if (positionals.length < 2) {
          throw new ScriptSyncClientError('Usage: snu record update <table> <sys_id> <field> (--value <v> | --file <path> | stdin)', 'E_INVALID_PARAMS');
        }
        inputData.table = positionals[0];
        inputData.sys_id = positionals[1];

        // If 3rd positional is given (e.g. "short_description" or "short_description=foo")
        if (positionals[2]) {
          const rawFieldToken = positionals[2];
          if (rawFieldToken.includes('=') && values.value === undefined && values.file === undefined) {
            const eqIdx = rawFieldToken.indexOf('=');
            inputData.field = rawFieldToken.slice(0, eqIdx);
            inputData.content = rawFieldToken.slice(eqIdx + 1);
          } else {
            inputData.field = rawFieldToken;
          }
        }

        if (inputData.content === undefined) {
          inputData.content = await resolveContentInput({
            value: values.value as string | undefined,
            filePath: values.file as string | undefined,
          });
        }
        if (!inputData.field) {
          throw new ScriptSyncClientError('Missing field name to update', 'E_INVALID_PARAMS');
        }
        if (inputData.content === undefined) {
          throw new ScriptSyncClientError('Missing new field content: provide --value <v>, --file <path>, or pipe via stdin', 'E_INVALID_PARAMS');
        }
        break;

      case 'record delete':
        if (!positionals[0] || !positionals[1]) {
          throw new ScriptSyncClientError('Usage: snu record delete <table> <sys_id> [--confirm] [--dry-run]', 'E_INVALID_PARAMS');
        }
        inputData.table = positionals[0];
        inputData.sys_id = positionals[1];
        break;

      case 'run': {
        const positionalScript = positionals.length > 0 ? positionals.join(' ') : undefined;
        // A positional script containing a literal backslash-n never reaches the
        // instance as a newline — it is sent verbatim and fails to compile there,
        // with an error that points at the script rather than at the quoting.
        if (positionalScript && /\\[nrt]/.test(positionalScript)) {
          throw new ScriptSyncClientError(
            'The script contains literal \\n escape sequences, which ServiceNow receives verbatim and fails to compile. ' +
              'Pass multiline scripts with --file <path> or pipe them via stdin, which preserve real newlines.',
            'E_INVALID_PARAMS'
          );
        }
        inputData.script = await resolveContentInput({
          value: positionalScript,
          filePath: values.file as string | undefined,
        });
        if (!inputData.script) {
          throw new ScriptSyncClientError('Usage: snu run [script] [--file <path>] or pipe via stdin', 'E_INVALID_PARAMS');
        }
        break;
      }

      case 'browser form':
        if (values.fields) {
          inputData.fields = String(values.fields).split(',').map((f) => f.trim()).filter(Boolean);
        }
        break;

      case 'browser set':
        if (!positionals[0] || positionals[1] === undefined) {
          throw new ScriptSyncClientError('Usage: snu browser set <field> <value>', 'E_INVALID_PARAMS');
        }
        inputData.field = positionals[0];
        inputData.value = positionals.slice(1).join(' ');
        break;

      case 'browser action':
        if (!positionals[0]) {
          throw new ScriptSyncClientError('Usage: snu browser action <action>', 'E_INVALID_PARAMS');
        }
        inputData.uiAction = positionals[0];
        break;

      case 'browser nav':
        if (!positionals[0]) {
          throw new ScriptSyncClientError('Usage: snu browser nav <url>', 'E_INVALID_PARAMS');
        }
        inputData.url = positionals[0];
        break;

      case 'screenshot':
        if (values.url) inputData.url = values.url;
        if (values.tab) inputData.tabId = parseInt(String(values.tab), 10);
        if (!inputData.url && inputData.tabId === undefined) {
          // If neither provided, default to matching ServiceNow tab
          inputData.url = 'https://*.service-now.com/*';
        }
        break;
    }

    // Execute through Client
    const client = new ScriptSyncClient({ portFile, cwd: process.cwd() });
    let result: any;

    if (tool.agentCommand === 'get_context') {
      result = await client.getContext(inputData.instance);
    } else {
      const mapped = tool.mapInput(inputData);
      const resp = await client.execute(mapped);
      result = resp.result;
    }

    // Output Result
    if (isJsonMode) {
      outputJson(result);
    } else {
      process.stdout.write(formatHumanOutput(tool.agentCommand, result, tool.cliCommand));
    }
    await printUpdateNotice(updateNotice);
  } catch (err: any) {
    outputError(err, isJsonMode);
    process.exit(1);
  }
}
