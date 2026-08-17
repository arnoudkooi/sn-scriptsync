import { parseArgs } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { TOOLS, getToolByCliCommand } from '../registry.js';
import { ScriptSyncClient, ScriptSyncClientError } from '../client.js';
import { resolveContentInput } from './stdin.js';
import { formatHumanOutput, outputJson, outputError } from './format.js';
import { startMcpServer } from '../mcp/index.js';
import { StandaloneBridge } from '../server/standalone.js';

const packageMetadata = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
) as { version: string };

export const VERSION = packageMetadata.version;

export function printHelp(): void {
  console.log(`
\x1b[1mSN Utils CLI (snu)\x1b[0m — Unified CLI and MCP Bridge for ServiceNow

\x1b[1mUSAGE:\x1b[0m
  snu <command> [arguments...] [options...]
  snu --mcp                           Start Model Context Protocol (MCP) server on stdio
  snu serve [--port <p>] [--ws <p>]   Start persistent standalone bridge daemon

\x1b[1mCORE COMMANDS:\x1b[0m
  context                             Show active connection, helper tab, and instance roster
  search <term>                       Fast GraphQL code search across script tables (Pro)
  schema <table>                      Inspect table columns, types, references, and choices
  query <table> [query]               Query records with encoded query and field projections
  run [script]                        Execute server-side Background Script and capture output

\x1b[1mRECORD & ARTIFACT COMMANDS:\x1b[0m
  record get <table> <sys_id>         Fetch a record by sys_id
  record update <table> <sys_id> <f>  Update a record field (--value <v>, --file <p>, or stdin)
  record delete <table> <sys_id>      Delete a record (--confirm or --dry-run)
  artifact create <table> <name>      Create a scriptable artifact (Script Include, etc.)

\x1b[1mBROWSER COMMANDS:\x1b[0m
  browser form                        Read live form table, sys_id, and fields via g_form
  browser set <field> <value>         Set live form field value via g_form.setValue
  browser action <action>             Trigger form UI action (e.g. save, sysverb_update)
  browser nav <url>                   Navigate connected tab to URL and wait for load
  screenshot                          Capture viewport screenshot of active tab

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
    return;
  }

  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(`snu v${VERSION}`);
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
    return;
  }

  // Handle standalone daemon command: snu serve
  if (nonGlobalTokens[0] === 'serve') {
    const standalone = new StandaloneBridge({
      cwd: process.cwd(),
      onYield: () => {
        console.log('\n[snu] VS Code requested port handover. Standalone bridge yielded ports.');
        process.exit(0);
      },
    });

    try {
      const { httpPort, wsPort } = await standalone.start();
      console.log(`\n\x1b[1m\x1b[32m[snu] Standalone Bridge Active\x1b[0m`);
      console.log(`  • HTTP API:    http://127.0.0.1:${httpPort}/api`);
      console.log(`  • WebSocket:   ws://127.0.0.1:${wsPort} (connect via SN Utils helper tab)`);
      console.log(`\n\x1b[90mRunning standalone. Press Ctrl+C to stop.\x1b[0m\n`);
    } catch (err: any) {
      outputError(err, false);
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

    // Prepare parseArgs options schema from tool definition
    const optionsConfig: Record<string, { type: 'string' | 'boolean'; short?: string }> = {
      json: { type: 'boolean', short: 'j' },
      instance: { type: 'string', short: 'i' },
      'port-file': { type: 'string' },
    };

    if (tool.cliOptions) {
      for (const [optName, optDef] of Object.entries(tool.cliOptions)) {
        optionsConfig[optName] = {
          type: optDef.type,
          short: optDef.short,
        };
      }
    }

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

      case 'run':
        const positionalScript = positionals.length > 0 ? positionals.join(' ') : undefined;
        inputData.script = await resolveContentInput({
          value: positionalScript,
          filePath: values.file as string | undefined,
        });
        if (!inputData.script) {
          throw new ScriptSyncClientError('Usage: snu run [script] [--file <path>] or pipe via stdin', 'E_INVALID_PARAMS');
        }
        break;

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
      process.stdout.write(formatHumanOutput(tool.agentCommand, result));
    }
  } catch (err: any) {
    outputError(err, isJsonMode);
    process.exit(1);
  }
}
