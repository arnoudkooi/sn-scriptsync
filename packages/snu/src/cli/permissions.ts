import * as fs from 'fs';
import * as path from 'path';
import { SecurityGates } from '../server/policy.js';
import {
  GATE_DEFINITIONS,
  GateDefinition,
  parseStrictBool,
  readStandaloneSettings,
  standaloneSettingsFile,
} from '../server/config.js';

// `snu permissions`: the standalone bridge's gates are the user's decision and
// deliberately out of the agent's reach (no MCP tool sets them), but until
// this command the only way to change one was to know the settings file's
// path and shape by heart. CLI only; never exposed over MCP.

export type GateSource = 'default' | 'file' | 'env' | 'inherited';

export interface GateStatus {
  gate: keyof SecurityGates;
  label: string;
  envVar: string;
  summary: string;
  value: boolean;
  source: GateSource;
  fileValue?: boolean;
  envValue?: boolean;
}

export interface PermissionReport {
  file: string;
  fileExists: boolean;
  gates: GateStatus[];
}

export interface LiveBridgeGates {
  pid: number;
  version?: string;
  gates: Partial<Record<keyof SecurityGates, unknown>>;
}

const ALIASES: Record<string, keyof SecurityGates> = {};
for (const def of GATE_DEFINITIONS) {
  const kebab = def.key.replace(/([A-Z])/g, '-$1').toLowerCase();
  const snake = kebab.replace(/-/g, '_');
  for (const alias of [def.key, kebab, snake, def.envVar, def.envVar.replace(/^SNU_ALLOW_/, ''), def.label.replace(/\s+/g, '')]) {
    ALIASES[alias.toLowerCase()] = def.key;
  }
}

/** camelCase key, kebab-case, snake_case, the env var, or the label. */
export function resolveGateName(input: string | undefined): keyof SecurityGates | undefined {
  if (!input) return undefined;
  return ALIASES[String(input).trim().toLowerCase()];
}

export function gateDefinition(gate: keyof SecurityGates): GateDefinition {
  return GATE_DEFINITIONS.find((def) => def.key === gate)!;
}

export function parseOnOff(input: string | undefined): boolean | undefined {
  return parseStrictBool(input);
}

export function describePermissions(options: { settingsFile?: string; env?: NodeJS.ProcessEnv } = {}): PermissionReport {
  const file = options.settingsFile ?? standaloneSettingsFile();
  const env = options.env ?? process.env;
  const settings = readStandaloneSettings(file);
  const gates: GateStatus[] = GATE_DEFINITIONS.map((def) => {
    const fileValue = typeof settings[def.key] === 'boolean' ? (settings[def.key] as boolean) : undefined;
    const envValue = parseStrictBool(env[def.envVar]);
    let value = def.defaultValue;
    let source: GateSource = 'default';
    if (fileValue !== undefined) { value = fileValue; source = 'file'; }
    if (envValue !== undefined) { value = envValue; source = 'env'; }
    return { gate: def.key, label: def.label, envVar: def.envVar, summary: def.summary, value, source, fileValue, envValue };
  });
  // updateRecords follows the create decision unless it was named explicitly.
  const update = gates.find((g) => g.gate === 'updateRecords')!;
  if (update.source === 'default') {
    update.value = gates.find((g) => g.gate === 'createArtifacts')!.value;
    update.source = 'inherited';
  }
  return { file, fileExists: fs.existsSync(file), gates };
}

export interface PermissionChange {
  file: string;
  gate: keyof SecurityGates;
  previous: boolean | undefined;
  next: boolean | undefined;
}

function writeSettings(file: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/** Write one gate into the settings file, keeping every other key as it was. */
export function setPermission(options: { settingsFile?: string; gate: keyof SecurityGates; value: boolean }): PermissionChange {
  const file = options.settingsFile ?? standaloneSettingsFile();
  const settings = readStandaloneSettings(file);
  const previous = typeof settings[options.gate] === 'boolean' ? (settings[options.gate] as boolean) : undefined;
  settings[options.gate] = options.value;
  writeSettings(file, settings);
  return { file, gate: options.gate, previous, next: options.value };
}

/** Remove one gate from the settings file so the default (or env) applies again. */
export function unsetPermission(options: { settingsFile?: string; gate: keyof SecurityGates }): PermissionChange {
  const file = options.settingsFile ?? standaloneSettingsFile();
  const settings = readStandaloneSettings(file);
  const previous = typeof settings[options.gate] === 'boolean' ? (settings[options.gate] as boolean) : undefined;
  delete settings[options.gate];
  writeSettings(file, settings);
  return { file, gate: options.gate, previous, next: undefined };
}

/** Which gates the running bridge has that differ from what the file + env now say. */
export function staleLiveGates(report: PermissionReport, live: LiveBridgeGates | null | undefined): GateStatus[] {
  if (!live) return [];
  return report.gates.filter((g) => {
    const liveValue = live.gates[g.gate];
    if (liveValue === undefined) return false;
    const liveOn = liveValue === true || liveValue === 'auto' || liveValue === 'approve';
    return liveOn !== g.value;
  });
}

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', gray: '\x1b[90m',
};

export function formatPermissions(report: PermissionReport, live?: LiveBridgeGates | null): string {
  const lines: string[] = [''];
  lines.push(`${C.bold}Standalone snu permissions${C.reset} ${C.gray}(${report.file}${report.fileExists ? '' : ', not created yet'})${C.reset}`);
  lines.push('');
  const width = Math.max(...report.gates.map((g) => g.label.length));
  for (const g of report.gates) {
    const state = g.value ? `${C.green}on ${C.reset}` : `${C.yellow}off${C.reset}`;
    const source = g.source === 'env' ? `${g.envVar}` : g.source;
    lines.push(`  ${g.label.padEnd(width)}  ${state}  ${C.gray}${source.padEnd(10)} ${g.gate}${C.reset}`);
  }
  const stale = staleLiveGates(report, live);
  if (live) {
    const who = `bridge PID ${live.pid}${live.version ? `, @snutils/snu ${live.version}` : ''}`;
    if (stale.length) {
      lines.push('');
      lines.push(`  ${C.yellow}The running ${who} still has ${stale.map((g) => `${g.label} ${g.value ? 'off' : 'on'}`).join(', ')}.${C.reset} Run ${C.bold}snu restart${C.reset} to apply.`);
    } else {
      lines.push('');
      lines.push(`  ${C.gray}The running ${who} matches.${C.reset}`);
    }
  }
  lines.push('');
  lines.push(`${C.dim}Change one:  snu permissions set browserDebugger on${C.reset}`);
  lines.push(`${C.dim}Environment: SNU_ALLOW_* variables override the file. A bridge started by an MCP client uses that client's env block, not this shell's.${C.reset}`);
  lines.push('');
  return lines.join('\n');
}
