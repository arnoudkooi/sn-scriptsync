import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SecurityGates } from './policy.js';

export interface StandaloneConfig {
  gates: SecurityGates;
  reviewHighRisk: boolean;
}

export interface GateDefinition {
  key: keyof SecurityGates;
  label: string;
  envVar: string;
  defaultValue: boolean;
  /** What turning it on lets an agent do, for `snu permissions`. */
  summary: string;
}

// The one table every surface reads: the config loader, the dispatcher's
// E_DISABLED messages and `snu permissions`. Order is the display order.
export const GATE_DEFINITIONS: GateDefinition[] = [
  { key: 'createArtifacts', label: 'Create Artifacts', envVar: 'SNU_ALLOW_CREATE_ARTIFACTS', defaultValue: true, summary: 'create records and scriptable artifacts' },
  { key: 'updateRecords', label: 'Update Records', envVar: 'SNU_ALLOW_UPDATE_RECORDS', defaultValue: true, summary: 'change fields on existing records (follows Create Artifacts unless set)' },
  { key: 'deleteRecords', label: 'Delete Records', envVar: 'SNU_ALLOW_DELETE_RECORDS', defaultValue: false, summary: 'delete records' },
  { key: 'backgroundScripts', label: 'Background Scripts', envVar: 'SNU_ALLOW_BACKGROUND_SCRIPTS', defaultValue: false, summary: 'run server-side scripts' },
  { key: 'restRequest', label: 'REST Request API', envVar: 'SNU_ALLOW_REST_REQUEST', defaultValue: false, summary: 'POST, PUT and PATCH through the generic REST tool' },
  { key: 'browserDebugger', label: 'Browser Debugger', envVar: 'SNU_ALLOW_BROWSER_DEBUGGER', defaultValue: false, summary: 'capture through the Chrome debugger (SN Utils Debug edition + Pro)' },
];

/** The user-controlled settings file the standalone bridge reads at start. */
export function standaloneSettingsFile(home: string = os.homedir()): string {
  return path.join(home, '.sn-scriptsync', 'settings.json');
}

/** Parsed settings file; {} when absent or empty. Throws on unparseable JSON. */
export function readStandaloneSettings(file: string = standaloneSettingsFile()): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return data as Record<string, unknown>;
}

export function parseStrictBool(val: string | undefined): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  const lower = String(val).trim().toLowerCase();
  if (lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on') return true;
  if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return false;
  return undefined;
}

export interface ResolveConfigOptions {
  settingsFile?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveStandaloneConfig(
  cliFlags?: Partial<SecurityGates & { reviewHighRisk?: boolean }>,
  options: ResolveConfigOptions = {}
): StandaloneConfig {
  const env = options.env ?? process.env;

  // 1. Start with fail-closed defaults
  const gates = {} as SecurityGates;
  for (const def of GATE_DEFINITIONS) gates[def.key] = def.defaultValue;
  // Resolved at the end of this function: with nothing configured for it,
  // "may the agent change existing records" follows the create decision.
  let updateRecordsExplicit = false;
  let reviewHighRisk = true;

  // 2. Read user-controlled global file: ~/.sn-scriptsync/settings.json
  try {
    const data = readStandaloneSettings(options.settingsFile ?? standaloneSettingsFile());
    for (const def of GATE_DEFINITIONS) {
      const value = data[def.key];
      if (typeof value === 'boolean') {
        gates[def.key] = value;
        if (def.key === 'updateRecords') updateRecordsExplicit = true;
      }
    }
    if (typeof data.reviewHighRisk === 'boolean') reviewHighRisk = data.reviewHighRisk;
  } catch {}

  // 3. Strict Environment Variables
  for (const def of GATE_DEFINITIONS) {
    const value = parseStrictBool(env[def.envVar]);
    if (value !== undefined) {
      gates[def.key] = value;
      if (def.key === 'updateRecords') updateRecordsExplicit = true;
    }
  }
  const envRev = parseStrictBool(env.SNU_REVIEW_HIGH_RISK);
  if (envRev !== undefined) reviewHighRisk = envRev;

  // 4. Explicit CLI Flags (highest priority)
  if (cliFlags) {
    for (const def of GATE_DEFINITIONS) {
      const value = cliFlags[def.key];
      if (typeof value === 'boolean') {
        gates[def.key] = value;
        if (def.key === 'updateRecords') updateRecordsExplicit = true;
      }
    }
    if (typeof cliFlags.reviewHighRisk === 'boolean') reviewHighRisk = cliFlags.reviewHighRisk;
  }

  // 5. Inherit the create decision when nothing named updateRecords explicitly,
  //    so a host locked down with SNU_ALLOW_CREATE_ARTIFACTS=0 does not leave
  //    update_record wide open.
  if (!updateRecordsExplicit) gates.updateRecords = gates.createArtifacts;

  return { gates, reviewHighRisk };
}
