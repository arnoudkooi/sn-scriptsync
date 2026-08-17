import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SecurityGates } from './policy.js';

export interface StandaloneConfig {
  gates: SecurityGates;
  reviewHighRisk: boolean;
}

function parseStrictBool(val: string | undefined): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  const lower = String(val).trim().toLowerCase();
  if (lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on') return true;
  if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return false;
  return undefined;
}

export function resolveStandaloneConfig(cliFlags?: Partial<SecurityGates & { reviewHighRisk?: boolean }>): StandaloneConfig {
  // 1. Start with fail-closed defaults
  const gates: SecurityGates = {
    backgroundScripts: false,
    deleteRecords: false,
    createArtifacts: true,
    browserDebugger: false,
    restRequest: false,
  };
  let reviewHighRisk = true;

  // 2. Read user-controlled global file: ~/.sn-scriptsync/settings.json
  try {
    const globalSettingsFile = path.join(os.homedir(), '.sn-scriptsync', 'settings.json');
    if (fs.existsSync(globalSettingsFile)) {
      const raw = fs.readFileSync(globalSettingsFile, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data.backgroundScripts === 'boolean') gates.backgroundScripts = data.backgroundScripts;
      if (typeof data.deleteRecords === 'boolean') gates.deleteRecords = data.deleteRecords;
      if (typeof data.createArtifacts === 'boolean') gates.createArtifacts = data.createArtifacts;
      if (typeof data.browserDebugger === 'boolean') gates.browserDebugger = data.browserDebugger;
      if (typeof data.restRequest === 'boolean') gates.restRequest = data.restRequest;
      if (typeof data.reviewHighRisk === 'boolean') reviewHighRisk = data.reviewHighRisk;
    }
  } catch {}

  // 3. Strict Environment Variables
  const envBg = parseStrictBool(process.env.SNU_ALLOW_BACKGROUND_SCRIPTS);
  if (envBg !== undefined) gates.backgroundScripts = envBg;

  const envDel = parseStrictBool(process.env.SNU_ALLOW_DELETE_RECORDS);
  if (envDel !== undefined) gates.deleteRecords = envDel;

  const envArt = parseStrictBool(process.env.SNU_ALLOW_CREATE_ARTIFACTS);
  if (envArt !== undefined) gates.createArtifacts = envArt;

  const envDbg = parseStrictBool(process.env.SNU_ALLOW_BROWSER_DEBUGGER);
  if (envDbg !== undefined) gates.browserDebugger = envDbg;

  const envRest = parseStrictBool(process.env.SNU_ALLOW_REST_REQUEST);
  if (envRest !== undefined) gates.restRequest = envRest;

  const envRev = parseStrictBool(process.env.SNU_REVIEW_HIGH_RISK);
  if (envRev !== undefined) reviewHighRisk = envRev;

  // 4. Explicit CLI Flags (highest priority)
  if (cliFlags) {
    if (typeof cliFlags.backgroundScripts === 'boolean') gates.backgroundScripts = cliFlags.backgroundScripts;
    if (typeof cliFlags.deleteRecords === 'boolean') gates.deleteRecords = cliFlags.deleteRecords;
    if (typeof cliFlags.createArtifacts === 'boolean') gates.createArtifacts = cliFlags.createArtifacts;
    if (typeof cliFlags.browserDebugger === 'boolean') gates.browserDebugger = cliFlags.browserDebugger;
    if (typeof cliFlags.restRequest === 'boolean') gates.restRequest = cliFlags.restRequest;
    if (typeof cliFlags.reviewHighRisk === 'boolean') reviewHighRisk = cliFlags.reviewHighRisk;
  }

  return { gates, reviewHighRisk };
}
