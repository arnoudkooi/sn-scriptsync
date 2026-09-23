import { classifyProbe, helperFailureHint } from './authProbe.js';
import { discoverScopeFields, readAllPages, pageState, FetchPage, FieldDefinition } from './scopeDiscovery.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { StandaloneWsBridge } from './wsBridge.js';
import { defaultPendingRegistry, PendingRegistry } from './pendingRegistry.js';
import { AgentRequest, AgentResponse } from '../types.js';
import { getCommandPolicy, SecurityGates } from './policy.js';
import { resolveStandaloneConfig, StandaloneConfig } from './config.js';
import { computePayloadHash } from './canonical.js';
import { AGENT_API_VERSION } from '../types.js';
import { resolveCreateScope, ScopeResolution, ScopeRow } from './scopeResolver.js';

const FOLDERRECORDTABLES = ['sp_widget', 'sp_header_footer', 'sys_ui_page'];

// Helper tab action names this host sends for the browser-relayed commands.
// The helper tab dispatches on the exact string and drops an unknown action
// without answering, so a wrong name here only ever surfaces as E_TIMEOUT
// 70 seconds later (take_screenshot shipped as 'agentTakeScreenshot' and never
// worked in standalone mode). Keep in step with the dispatch chain in the
// extension's scriptsync.js; browserRelay.test.ts pins these values.
export const BROWSER_ACTIONS = {
  get_form_state: 'agentGetFormState',
  set_field: 'agentSetField',
  run_ui_action: 'agentRunUiAction',
  navigate: 'agentNavigate',
  take_screenshot: 'takeScreenshot',
  switch_context: 'switchContext',
} as const;

const SWITCH_CONTEXT_TYPES = ['updateset', 'application', 'domain'];
const SWITCH_CONTEXT_ALIASES: Record<string, string> = {
  app: 'application',
  scope: 'application',
  update_set: 'updateset',
  'update-set': 'updateset',
};

// Human labels + the environment variable each gate is *actually* read from in
// config.ts. Deriving the variable name from the camelCase gate key produces
// SNU_ALLOW_RESTREQUEST, which nothing reads, so an agent told to set it hits
// the same wall twice and starts looking for a way around the gate. Keep these
// tables in step with resolveStandaloneConfig().
const GATE_LABELS: Record<keyof SecurityGates, string> = {
  backgroundScripts: 'Background Scripts',
  deleteRecords: 'Delete Records',
  createArtifacts: 'Create Artifacts',
  updateRecords: 'Update Records',
  browserDebugger: 'Browser Debugger',
  restRequest: 'REST Request API',
};

const REST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Mirrors codeForRest() in the VS Code agent so both hosts report the same
// code for the same HTTP failure.
function codeForRestStatus(status: number | undefined, message: string): string {
  if (status === 404) return 'E_NOT_FOUND';
  if (status === 409) return 'E_REFERENCE_INTEGRITY';
  if (status === 401 || status === 403) return 'E_ACL';
  const lower = (message || '').toLowerCase();
  if (lower.includes('cannot delete') || lower.includes('referenc') || lower.includes('cascade')) {
    return 'E_REFERENCE_INTEGRITY';
  }
  return 'E_COMMAND_FAILED';
}

const GATE_ENV_VARS: Record<keyof SecurityGates, string> = {
  backgroundScripts: 'SNU_ALLOW_BACKGROUND_SCRIPTS',
  deleteRecords: 'SNU_ALLOW_DELETE_RECORDS',
  createArtifacts: 'SNU_ALLOW_CREATE_ARTIFACTS',
  updateRecords: 'SNU_ALLOW_UPDATE_RECORDS',
  browserDebugger: 'SNU_ALLOW_BROWSER_DEBUGGER',
  restRequest: 'SNU_ALLOW_REST_REQUEST',
};

// Steps a user must take to (re)connect the browser helper tab. Rendered by
// the CLI as a friendly block and relayed verbatim by the MCP server so
// agents guide the user instead of reporting a raw error.
export const HELPER_CONNECT_GUIDANCE = [
  'Open your ServiceNow instance in the browser (with the SN Utils extension installed).',
  'On that page, type /token in the SN Utils slash palette: this opens the helper tab and connects it.',
  'Keep the helper tab open, then retry.',
];

const FIELDTYPES: Record<string, { extension: string }> = {
  script: { extension: '.js' },
  script_plain: { extension: '.js' },
  script_server: { extension: '.js' },
  script_client: { extension: '.js' },
  email_script: { extension: '.js' },
  html_script: { extension: '.html' },
  xml: { extension: '.xml' },
  html: { extension: '.html' },
  html_template: { extension: '.html' },
  template: { extension: '.html' },
  json: { extension: '.json' },
  css: { extension: '.scss' },
  condition_string: { extension: '.js' },
  expression: { extension: '.js' },
  graphql_schema: { extension: '.graphql' },
  json_translations: { extension: '.json' },
  translated_html: { extension: '.html' },
  string: { extension: '.txt' },
};

function sanitizePathComponent(component: string): string {
  if (typeof component !== 'string') {
    throw new Error('Path component is not a string');
  }
  const value = component.trim();
  if (!value || value === '.' || value === '..') {
    throw new Error(`Unsafe path component ${JSON.stringify(component)}`);
  }
  if (/[\\/\0]/.test(value) || /^[A-Za-z]:/.test(value) || value.startsWith('~')) {
    throw new Error(`Unsafe path component ${JSON.stringify(component)}`);
  }
  return value;
}

function safeJoinUnderRoot(root: string, ...components: string[]): string {
  if (!root) {
    throw new Error('No root path provided');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...components.map(sanitizePathComponent));
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes root: ${resolved}`);
  }
  return resolved;
}

let metaDataRelationsCache: any = null;
function getMetaDataRelations(cwd: string): any {
  if (!metaDataRelationsCache) {
    const candidates = [
      path.resolve(cwd, 'resources', 'metaDataRelations.json'),
      path.resolve(__dirname, '../../../../resources/metaDataRelations.json'),
      path.resolve(__dirname, '../../../resources/metaDataRelations.json'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        try {
          metaDataRelationsCache = JSON.parse(fs.readFileSync(c, 'utf8'));
          break;
        } catch {}
      }
    }
  }
  return metaDataRelationsCache;
}

function resolveTableCodeFields(tableName: string, cwd: string): string[] {
  const meta = getMetaDataRelations(cwd);
  const fields = meta?.tableFields?.[tableName]?.codeFields;
  if (fields && typeof fields === 'object') {
    const keys = Object.keys(fields).filter((k) => !k.startsWith('_'));
    if (keys.length > 0) return keys;
  }
  return ['script'];
}

function resolveFieldExtension(tableName: string, fieldName: string, cwd: string, liveType?: string): string {
  const meta = getMetaDataRelations(cwd);
  let fieldType = 'script';
  try {
    fieldType = liveType || meta?.tableFields?.[tableName]?.codeFields?.[fieldName]?.type || fieldName;
  } catch {}

  let ext = FIELDTYPES[fieldType]?.extension;
  if (fieldType.includes('xml')) ext = '.xml';
  else if (fieldType.includes('html')) ext = '.html';
  else if (fieldType.includes('json')) ext = '.json';
  else if (fieldType.includes('css') || fieldType === 'properties' || fieldName === 'css') ext = '.scss';
  else if (fieldType.includes('string') || fieldType === 'conditions') ext = '.txt';
  else if (fieldType.includes('graphql')) ext = '.graphql';
  else if (!ext) ext = '.js';

  return ext;
}

// Canonical filename resolution against a folder's _map.json, shared by
// pull_records and browser save pushes. Mirrors the VS Code extension: an
// existing mapping for the sys_id wins (so a record renamed on the instance
// keeps its stable local filename, reported via `renamedTo`), and a name
// collision with another sys_id gets a short sys_id suffix.
export function resolveMappedFileName(
  mapPath: string,
  rawName: string,
  sysId: string
): { cleanName: string; renamedTo?: string; map: Record<string, string> } {
  let nameToSysId: Record<string, string> = {};
  if (fs.existsSync(mapPath)) {
    try { nameToSysId = JSON.parse(fs.readFileSync(mapPath, 'utf8')) || {}; } catch {}
  }

  const computed = String(rawName).replace(/[^a-z0-9._\-+]+/gi, '').replace(/\./g, '-') || sysId;
  let cleanName = computed;
  let renamedTo: string | undefined;

  const existingKey = Object.keys(nameToSysId).find((k) => nameToSysId[k] === sysId);
  if (existingKey) {
    cleanName = existingKey;
    if (existingKey !== computed) renamedTo = computed;
  } else if (nameToSysId[cleanName] && nameToSysId[cleanName] !== sysId) {
    cleanName = cleanName + ('-' + sysId.slice(0, 2) + sysId.slice(-2)).toUpperCase();
  }

  nameToSysId[cleanName] = sysId;
  return { cleanName, renamedTo, map: nameToSysId };
}

function writeMapFile(mapPath: string, map: Record<string, string>): void {
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 4), 'utf8');
}

// Extension for a browser save push, derived from the payload's fieldType the
// same way the VS Code extension does it (saveFieldAsFile).
function extensionForBrowserSave(fieldType: string, fieldName: string, tableName: string, cleanName: string): string {
  let ext = FIELDTYPES[fieldType]?.extension;
  if (fieldType.includes('xml')) ext = '.xml';
  else if (fieldType.includes('html')) ext = '.html';
  else if (fieldType.includes('json')) ext = '.json';
  else if (fieldType.includes('css') || fieldType === 'properties' || fieldName === 'css') ext = '.scss';
  else if (cleanName.lastIndexOf('-') > -1 && tableName === 'ecc_agent_script_file') {
    const suffix = cleanName.substring(cleanName.lastIndexOf('-') + 1);
    if (suffix.length < 5) ext = '.' + suffix;
  }
  else if (fieldType.includes('string') || fieldType === 'conditions') ext = '.txt';
  else if (fieldName === 'PowerShell') ext = '.ps1';
  return ext || '.js';
}

export interface StandaloneDispatcherOptions {
  cwd?: string;
  wsBridge: StandaloneWsBridge;
  pending?: PendingRegistry;
  cliFlags?: Partial<SecurityGates & { reviewHighRisk?: boolean }>;
}

export class StandaloneDispatcher {
  private cwd: string;
  private ws: StandaloneWsBridge;
  private pending: PendingRegistry;
  private config: StandaloneConfig;
  private pendingReviewRequests = new Map<string, string>(); // correlationId/requestId -> reviewId
  /** Pause before the single retry after E_SCREENSHOT_PERMISSION; tests shorten it. */
  screenshotRetryDelayMs = 10_000;
  private requestIdToCorrelationId = new Map<string, string>(); // requestId -> correlationId

  constructor(opts: StandaloneDispatcherOptions) {
    this.cwd = opts.cwd || process.cwd();
    this.ws = opts.wsBridge;
    this.pending = opts.pending || defaultPendingRegistry;
    this.config = resolveStandaloneConfig(opts.cliFlags);
  }

  getWorkspaceRoot(): string {
    return this.cwd;
  }

  getInstanceSettings(instanceName: string): any {
    const p1 = path.join(this.cwd, instanceName, '_settings.json');
    const p2 = path.join(this.cwd, instanceName, 'settings.json');
    if (fs.existsSync(p1)) {
      try { return JSON.parse(fs.readFileSync(p1, 'utf8')); } catch {}
    }
    if (fs.existsSync(p2)) {
      try { return JSON.parse(fs.readFileSync(p2, 'utf8')); } catch {}
    }
    return null;
  }

  // Browser save-icon pushes (action: 'saveFieldAsFile') arrive on the port
  // 1978 socket whether VS Code or this daemon is listening; VS Code writes
  // the field into the sync workspace, and historically the daemon dropped
  // the message silently. Mirror the VS Code behavior so a daemon-only setup
  // still lands pushes on disk. One-way by design: the daemon has no file
  // watcher, so local edits flow back via agent commands or VS Code.
  async handleBrowserFieldSave(msg: any): Promise<void> {
    const echo = (payload: any) => {
      try { this.ws.sendToBrowser(payload); } catch {}
    };
    try {
      const instanceName = sanitizePathComponent(String(msg?.instance?.name || ''));
      const table = sanitizePathComponent(String(msg?.table || ''));
      const sysId = String(msg?.sys_id || '');
      const rawName = String(msg?.name || '');
      const field = String(msg?.field || '');
      const content = typeof msg?.content === 'string' ? msg.content : String(msg?.content ?? '');
      if (!sysId || !field) throw new Error('Save push is missing sys_id or field');

      // Refuse to scatter files when the daemon was clearly started outside a
      // sync workspace.
      const resolvedCwd = path.resolve(this.cwd);
      if (resolvedCwd === path.resolve(os.homedir()) || resolvedCwd === path.parse(resolvedCwd).root) {
        console.warn(`[snu] Ignored a save push from the browser: ${resolvedCwd} does not look like a ScriptSync workspace. Start snu from your sync folder.`);
        return;
      }

      const scope = await this.resolveScopeFolderForSave(msg, instanceName);

      // Variable fields arrive as inputs.<var>.script
      const fieldName = field.split('.').length === 3 ? 'variable-' + field.split('.')[2] : field;

      const isFolderRecordTable = FOLDERRECORDTABLES.includes(table);
      const mapPath = safeJoinUnderRoot(this.cwd, instanceName, scope, table, '_map.json');
      const { cleanName, renamedTo, map } = resolveMappedFileName(mapPath, rawName, sysId);
      writeMapFile(mapPath, map);
      if (renamedTo) {
        console.log(`[snu] Record ${table}/${sysId} is named '${renamedTo}' on the instance but keeps local file name '${cleanName}' (rename tracked in _map.json).`);
      }

      const ext = extensionForBrowserSave(String(msg?.fieldType || 'script'), fieldName, table, cleanName);
      const targetPath = isFolderRecordTable
        ? safeJoinUnderRoot(this.cwd, instanceName, scope, table, cleanName, `${fieldName}${ext}`)
        : safeJoinUnderRoot(this.cwd, instanceName, scope, table, `${cleanName}.${fieldName}${ext}`);

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content, 'utf8');
      console.log(`[snu] Saved ${path.relative(this.cwd, targetPath)} (pushed from ${instanceName})`);

      // Same success echo VS Code sends: the helper tab logs the push as
      // delivered when it sees contentLength.
      echo({ ...msg, result: '', contentLength: content.length, send: false });
    } catch (e: any) {
      const message = e?.message || String(e);
      console.warn('[snu] Failed to save field pushed from browser:', message);
      echo({ error: `Standalone snu could not save the pushed field: ${message}`, send: false, response: { result: {} } });
    }
  }

  // Resolve the scope folder name for a browser save push. The payload's
  // `scope` is a sys_scope sys_id ('global' for global, '' when the form has
  // no sys_scope field). Mirrors the VS Code extension: scopes.json first,
  // then ask the instance, falling back to no_scope / unknown_scope.
  private async resolveScopeFolderForSave(msg: any, instanceName: string): Promise<string> {
    const scopeVal = typeof msg?.scope === 'string' ? msg.scope.trim() : '';
    if (scopeVal === 'global') return 'global';

    if (!scopeVal) {
      const fromRecord = await this.queryScopeFromInstance(
        msg,
        `/api/now/table/${msg.table}/${msg.sys_id}`,
        { sysparm_fields: 'sys_scope.scope', sysparm_exclude_reference_link: 'true' },
        'sys_scope.scope'
      );
      return fromRecord || 'no_scope';
    }

    if (/^[0-9a-f]{32}$/i.test(scopeVal)) {
      const scopesPath = path.join(this.cwd, instanceName, 'scopes.json');
      try {
        const scopes = JSON.parse(fs.readFileSync(scopesPath, 'utf8')) || {};
        const hit = Object.keys(scopes).find((k) => scopes[k] === scopeVal);
        if (hit) return hit;
      } catch {}

      const fromScope = await this.queryScopeFromInstance(
        msg,
        `/api/now/table/sys_scope/${scopeVal}`,
        { sysparm_fields: 'scope' },
        'scope'
      );
      if (fromScope) {
        // Best-effort persist name -> sys_id so the next save skips the round-trip.
        try {
          let scopes: Record<string, string> = {};
          try { scopes = JSON.parse(fs.readFileSync(scopesPath, 'utf8')) || {}; } catch {}
          if (scopes[fromScope] !== scopeVal) {
            scopes[fromScope] = scopeVal;
            fs.mkdirSync(path.dirname(scopesPath), { recursive: true });
            fs.writeFileSync(scopesPath, JSON.stringify(scopes, null, 4), 'utf8');
          }
        } catch {}
        return fromScope;
      }
      return 'unknown_scope';
    }

    // Already a scope name (e.g. flow action saves carry the name directly).
    if (/^[a-z0-9_.\-]+$/i.test(scopeVal)) return scopeVal;
    return 'unknown_scope';
  }

  private async queryScopeFromInstance(
    msg: any,
    endpoint: string,
    queryParams: Record<string, string>,
    resultField: string
  ): Promise<string | undefined> {
    if (!this.ws.hasBrowserClient()) return undefined;
    try {
      const correlationId = crypto.randomUUID();
      const pendingPromise = this.pending.register({ id: correlationId, command: 'resolve_scope_for_save', timeoutMs: 15_000 });
      this.ws.sendToBrowser({
        action: 'agentRestApi',
        agentRequestId: correlationId,
        endpoint,
        method: 'GET',
        queryParams,
        instance: msg.instance,
        appName: 'SN Utils CLI',
      });
      const res: any = await pendingPromise;
      if (res?.success === false) return undefined;
      const value = res?.data?.result?.[resultField];
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve a create's application scope.
   *
   * Delegates to the mirrored resolver so the CLI and the extension cannot
   * drift again: they diverged once already, with this host resolving scopes
   * properly while the extension hardcoded Global. Both suites run the same
   * conformance vectors.
   */
  private async resolveScopeForCreate(inst: any, scopeParam: unknown, fields: any): Promise<ScopeResolution> {
    const lookup = async (scopeName: string): Promise<ScopeRow | undefined> => {
      const correlationId = crypto.randomUUID();
      const pendingPromise = this.pending.register({
        id: correlationId,
        command: 'resolve_create_scope',
        timeoutMs: 15_000,
      });
      this.ws.sendToBrowser({
        action: 'agentRestApi',
        agentRequestId: correlationId,
        endpoint: '/api/now/table/sys_scope',
        method: 'GET',
        queryParams: {
          sysparm_query: `scope=${scopeName}`,
          sysparm_fields: 'sys_id,scope',
          sysparm_limit: '1',
          sysparm_exclude_reference_link: 'true',
        },
        instance: inst.settings,
        appName: 'SN Utils CLI',
      });
      const res: any = await pendingPromise;
      const row = Array.isArray(res?.data?.result) ? res.data.result[0] : undefined;
      if (!row) return undefined;
      const sysId = row.sys_id && typeof row.sys_id === 'object' ? row.sys_id.value : row.sys_id;
      const name = row.scope && typeof row.scope === 'object' ? row.scope.value : row.scope;
      return typeof sysId === 'string' && sysId.trim()
        ? { sys_id: sysId.trim(), scope: name || scopeName }
        : undefined;
    };

    return resolveCreateScope({ scope: scopeParam, fields, lookup });
  }

  listInstanceFolders(): string[] {
    try {
      const entries = fs.readdirSync(this.cwd, { withFileTypes: true });
      const nonInstance = new Set(['.vscode', '.cursor', '.git', 'node_modules', 'dist', 'bin', 'packages', 'screenshots', 'agentrules']);
      return entries
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !nonInstance.has(d.name.toLowerCase()))
        .map((d) => path.join(this.cwd, d.name))
        .filter((f) => fs.existsSync(path.join(f, '_settings.json')) || fs.existsSync(path.join(f, 'settings.json')));
    } catch {
      return [];
    }
  }

  // One page of one table into canonical workspace files. Shared by
  // pull_records (a single page the caller sized) and pull_scope (which walks
  // every code table of an application page by page).
  private async pullTablePage(inst: { name: string; settings: any }, reqCommand: string, opts: { table: string; query: string; codeFields: string[]; fieldDefinitions?: Record<string, FieldDefinition>; limit: number; offset?: number }) {
    const { table, codeFields, limit } = opts;
    const combinedQuery = opts.query;
    const offset = opts.offset || 0;
    const displayFields = ['sys_id', 'name', 'sys_name', 'short_description', 'sys_scope', 'sys_scope.scope'];
    const allRequestedFields = Array.from(new Set([...displayFields, ...codeFields])).join(',');

    const queryParams: Record<string, string> = {
      sysparm_fields: allRequestedFields,
      sysparm_limit: String(limit),
      sysparm_offset: String(offset),
      sysparm_display_value: 'false',
      sysparm_exclude_reference_link: 'true',
      sysparm_no_count: 'false',
    };
    if (combinedQuery) {
      queryParams.sysparm_query = combinedQuery;
    }

    const correlationId = crypto.randomUUID();
    const pendingPromise = this.pending.register({ id: correlationId, command: reqCommand, timeoutMs: 70_000 });
    this.ws.sendToBrowser({
      action: 'agentRestApi',
      agentRequestId: correlationId,
      endpoint: `/api/now/table/${table}`,
      method: 'GET',
      queryParams,
      instance: inst.settings,
      appName: 'SN Utils CLI',
    });
    const res = await pendingPromise;
    if (res.success === false) {
      throw Object.assign(new Error(res.error || 'Failed to pull records'), { code: 'E_COMMAND_FAILED' });
    }

    const matchedRecords: any[] = Array.isArray(res.data?.result) ? res.data.result : (res.data?.result ? [res.data.result] : []);
    const isFolderRecordTable = FOLDERRECORDTABLES.includes(table);

    let filesWritten = 0;
    let skippedEmpty = 0;
    let skippedUnreadable = 0;
    const warnings: string[] = [];
    const pulledRecordsList: Array<{
      sys_id: string;
      name: string;
      scope: string;
      files: Array<{ field: string; path: string; bytes: number; action: 'created' | 'updated' | 'cleared' | 'skipped_empty' }>;
    }> = [];

    for (const rec of matchedRecords) {
      const sysId = typeof rec.sys_id === 'object' ? rec.sys_id.value : String(rec.sys_id || '');
      if (!sysId) continue;

      let scope = 'global';
      if (rec['sys_scope.scope']) {
        scope = String(rec['sys_scope.scope']);
      } else if (rec.sys_scope) {
        scope = typeof rec.sys_scope === 'object' ? String(rec.sys_scope.value || rec.sys_scope.display_value || 'global') : String(rec.sys_scope);
      }
      if (!scope || scope === 'null' || scope === 'undefined') scope = 'global';

      const rawName = rec.name || rec.sys_name || rec.short_description || sysId;
      const name = String(rawName).trim();

      let mapPath: string;
      try {
        mapPath = safeJoinUnderRoot(this.cwd, inst.name, scope, table, '_map.json');
      } catch (e: any) {
        warnings.push(`Could not resolve map path for ${scope}/${table}: ${e?.message || e}`);
        continue;
      }

      const { cleanName, renamedTo, map: nameToSysId } = resolveMappedFileName(mapPath, name, sysId);
      try {
        writeMapFile(mapPath, nameToSysId);
      } catch (e: any) {
        warnings.push(`Failed to write _map.json at ${mapPath}: ${e?.message || e}`);
      }
      if (renamedTo) {
        warnings.push(`Record ${sysId} is named '${renamedTo}' on the instance but keeps local file name '${cleanName}' (rename tracked in _map.json).`);
      }

      if (table === 'sp_widget') {
        try {
          const testUrlsPath = safeJoinUnderRoot(this.cwd, inst.name, scope, table, cleanName, '_test_urls.txt');
          if (!fs.existsSync(testUrlsPath)) {
            const dispVal = name.toLowerCase().replace(/\s+/g, '_');
            const testUrls = [
              `${inst.settings.url}/$sp.do?id=sp-preview&sys_id=${sysId}`,
              `${inst.settings.url}/sp_config?id=${dispVal}`,
              `${inst.settings.url}/sp?id=${dispVal}`,
              `${inst.settings.url}/esc?id=${dispVal}`,
            ].join('\n');
            fs.mkdirSync(path.dirname(testUrlsPath), { recursive: true });
            fs.writeFileSync(testUrlsPath, testUrls, 'utf8');
          }
        } catch {}
      }

      const recordFiles: Array<{ field: string; path: string; bytes: number; action: 'created' | 'updated' | 'cleared' | 'skipped_empty' }> = [];

      for (const field of codeFields) {
        if (!Object.prototype.hasOwnProperty.call(rec, field)) {
          skippedUnreadable++;
          warnings.push(`${table}/${sysId}.${field}: field not returned; local file preserved.`);
          continue;
        }
        const ext = resolveFieldExtension(table, field, this.cwd, opts.fieldDefinitions?.[field]?.type);
        let targetPath: string;
        try {
          targetPath = isFolderRecordTable
            ? safeJoinUnderRoot(this.cwd, inst.name, scope, table, cleanName, `${field}${ext}`)
            : safeJoinUnderRoot(this.cwd, inst.name, scope, table, `${cleanName}.${field}${ext}`);
        } catch (e: any) {
          warnings.push(`Unsafe path for ${scope}/${table}/${cleanName}.${field}: ${e?.message || e}`);
          continue;
        }

        const relPath = path.relative(this.cwd, targetPath).replace(/\\/g, '/');
        const rawVal = rec[field];
        const content = rawVal !== null && rawVal !== undefined ? String(rawVal) : '';
        const fileExisted = fs.existsSync(targetPath);

        if (content.length > 0) {
          try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, content, 'utf8');
            filesWritten++;
            const action = fileExisted ? 'updated' : 'created';
            recordFiles.push({ field, path: relPath, bytes: Buffer.byteLength(content, 'utf8'), action });
          } catch (e: any) {
            warnings.push(`Failed to write ${relPath}: ${e?.message || e}`);
          }
        } else if (fileExisted) {
          try {
            fs.writeFileSync(targetPath, '', 'utf8');
            filesWritten++;
            recordFiles.push({ field, path: relPath, bytes: 0, action: 'cleared' });
          } catch (e: any) {
            warnings.push(`Failed to clear ${relPath}: ${e?.message || e}`);
          }
        } else {
          skippedEmpty++;
          recordFiles.push({ field, path: relPath, bytes: 0, action: 'skipped_empty' });
        }
      }

      pulledRecordsList.push({
        sys_id: sysId,
        name,
        scope,
        files: recordFiles,
      });
    }

    return {
      pagination: res.pagination,
      table,
      matchedRecords: matchedRecords.length,
      pulledRecords: pulledRecordsList.length,
      filesWritten,
      skippedEmpty,
      skippedUnreadable,
      warnings,
      records: pulledRecordsList,
    };
  }

  private async restGet(inst: { settings: any }, reqCommand: string, endpoint: string, queryParams: Record<string, string>, withPagination = false): Promise<any> {
    const correlationId = crypto.randomUUID();
    const pendingPromise = this.pending.register({ id: correlationId, command: reqCommand, timeoutMs: 70_000 });
    this.ws.sendToBrowser({
      action: 'agentRestApi',
      agentRequestId: correlationId,
      endpoint,
      method: 'GET',
      queryParams,
      instance: inst.settings,
      appName: 'SN Utils CLI',
    });
    const res: any = await pendingPromise;
    if (res?.success === false) {
      const hint = res?.status ? '' : helperFailureHint(typeof res?.error === 'string' ? res.error : '', inst.settings?.url);
      throw Object.assign(new Error([res.error || `REST request failed: ${endpoint}`, hint].filter(Boolean).join(' ')), { code: res.code || 'E_COMMAND_FAILED' });
    }
    return withPagination ? { rows: res?.data?.result, pagination: res?.pagination } : res?.data;
  }

  resolveInstance(requestInstance?: string): { name: string; folder: string; settings: any } {
    const folders = this.listInstanceFolders();
    const liveInstances = this.ws.getLiveInstances();
    const findLiveMatch = (name: string, url?: string): typeof liveInstances[number] | undefined => {
      let origin = '';
      try { origin = url ? new URL(url).origin.toLowerCase() : ''; } catch {}
      return liveInstances.find((candidate) => {
        let liveOrigin = '';
        try { liveOrigin = new URL(candidate.url).origin.toLowerCase(); } catch {}
        return (origin && liveOrigin === origin) || candidate.name.toLowerCase() === name.toLowerCase();
      });
    };

    if (requestInstance) {
      const settings = this.getInstanceSettings(requestInstance);
      if (settings) {
        const live = findLiveMatch(requestInstance, settings.url);
        return { name: requestInstance, folder: path.join(this.cwd, requestInstance), settings: live || settings };
      }

      const needle = requestInstance.toLowerCase().replace(/\/$/, '');
      const live = liveInstances.find((candidate) => {
        try {
          const url = new URL(candidate.url);
          return candidate.name.toLowerCase() === needle ||
            url.hostname.toLowerCase() === needle ||
            url.origin.toLowerCase() === needle;
        } catch {
          return false;
        }
      });
      if (live) {
        return { name: live.name, folder: this.cwd, settings: live };
      }

      const known = [
        ...liveInstances.map((candidate) => `${candidate.name} (${candidate.url})`),
        ...folders.map((folder) => path.basename(folder)),
      ];
      const knownText = known.length
        ? ` Known here: ${[...new Set(known)].join(', ')}. Pass one of these as the instance, by name, hostname or origin.`
        : ' This bridge has not received any session since it started.';
      throw Object.assign(new Error(`No authenticated instance named "${requestInstance}" is connected.${knownText} Otherwise open that exact hostname in the browser, run /token and retry.`), {
        code: 'E_INSTANCE_NOT_FOUND',
        details: { requested: requestInstance, liveInstances: liveInstances.map((candidate) => ({ name: candidate.name, url: candidate.url })) },
      });
    }

    if (folders.length === 1) {
      const name = path.basename(folders[0]);
      const settings = this.getInstanceSettings(name);
      return { name, folder: folders[0], settings: findLiveMatch(name, settings?.url) || settings };
    }

    if (folders.length === 0) {
      if (liveInstances.length > 0) {
        const live = liveInstances[0];
        return { name: live.name, folder: this.cwd, settings: live };
      }
      throw Object.assign(new Error('No authenticated ServiceNow instance is connected. Run /token on the instance and retry.'), {
        code: 'E_INSTANCE_REQUIRED',
      });
    }

    const known = folders.map((folder) => {
      const name = path.basename(folder);
      return { name, folder, settings: this.getInstanceSettings(name) };
    });
    const liveMatches = known.map((instance) => {
      const live = findLiveMatch(instance.name, instance.settings?.url);
      return live ? { ...instance, settings: live } : null;
    }).filter((instance): instance is NonNullable<typeof instance> => !!instance);

    if (liveMatches.length === 1) return liveMatches[0];

    const knownInstances = known.map((instance) => instance.name);
    const connectedInstances = liveMatches.map((instance) => instance.name);
    const names = (connectedInstances.length ? connectedInstances : knownInstances).join(', ');
    const message = connectedInstances.length
      ? `Multiple helper-connected instances found (${names}). Pass "instance": "<name>" in the request.`
      : `Multiple known workspace instances found (${names}); this does not mean they have live helper sessions. Pass "instance": "<name>" in the request.`;
    throw Object.assign(new Error(message), {
      code: 'E_INSTANCE_REQUIRED',
      details: { knownInstances, connectedInstances },
    });
  }

  cancel(requestId: string, reason = 'CANCELLED'): void {
    const correlationId = this.requestIdToCorrelationId.get(requestId) || requestId;
    const reviewId = this.pendingReviewRequests.get(correlationId) || this.pendingReviewRequests.get(requestId);
    if (reviewId) {
      this.pendingReviewRequests.delete(correlationId);
      this.pendingReviewRequests.delete(requestId);
      this.ws.cancelReview(reviewId, reason);
    }
    this.pending.cancel(correlationId, reason);
    this.pending.cancel(requestId, reason);
    this.requestIdToCorrelationId.delete(requestId);
  }

  // Screenshot round trip, mirroring the VS Code host: the helper answers a
  // takeScreenshot with base64 PNG data and this side writes the file under
  // <workspace>/screenshots. allowDebugger carries the user's browserDebugger
  // gate so a tab without an activeTab grant can be captured through the
  // Chrome debugger (Debug edition + Pro; the helper re-checks both). Without
  // it, or when the debugger path is not available, the helper asks for the
  // extension-icon click and this side retries once after a pause.
  private async captureScreenshot(req: AgentRequest, correlationId: string): Promise<Record<string, any>> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let fileName = typeof req.params?.fileName === 'string' && req.params.fileName.trim()
      ? req.params.fileName.trim()
      : `screenshot_${timestamp}.png`;
    if (!/\.png$/i.test(fileName)) fileName += '.png';
    const savePath = safeJoinUnderRoot(this.cwd, 'screenshots', fileName);

    const request = async (id: string, tabId: any): Promise<any> => {
      const pendingPromise = this.pending.register({ id, command: req.command, timeoutMs: 70_000 });
      this.ws.sendToBrowser({
        action: BROWSER_ACTIONS.take_screenshot,
        agentRequestId: id,
        url: req.params?.url,
        tabId,
        exactUrl: req.params?.exactUrl === true,
        focus: req.params?.focus === true,
        fileName,
        savePath,
        allowDebugger: this.config.gates.browserDebugger === true,
        appName: 'SN Utils CLI',
      });
      try {
        return await pendingPromise;
      } catch (err: any) {
        // The bridge rejects a failed helper reply; a permission refusal is
        // handled here (retry), so hand it back as a plain result.
        if (err?.code === 'E_SCREENSHOT_PERMISSION') {
          return {
            success: false,
            code: err.code,
            error: err.message,
            tabId: err.details?.tabId,
            tabUrl: err.details?.tabUrl,
            cdpFallbackAvailable: err.details?.cdpFallbackAvailable,
          };
        }
        throw err;
      }
    };

    let res = await request(correlationId, req.params?.tabId);
    if (res?.code === 'E_SCREENSHOT_PERMISSION') {
      // Give the user time to click the extension icon on the tab, then retry
      // once on the tab the helper named.
      await new Promise((resolve) => setTimeout(resolve, this.screenshotRetryDelayMs));
      if (!this.ws.hasBrowserClient()) {
        throw Object.assign(new Error('Browser helper disconnected while waiting for screenshot permission.'), { code: 'E_BROWSER_DISCONNECTED' });
      }
      res = await request(`${correlationId}_retry`, res.tabId ?? req.params?.tabId);
    }
    if (res?.code === 'E_SCREENSHOT_PERMISSION') {
      throw Object.assign(new Error(res.error || 'Browser denied the screenshot (tab not capturable / permission).'), {
        code: 'E_SCREENSHOT_PERMISSION',
        details: { tabId: res.tabId, tabUrl: res.tabUrl, cdpFallbackAvailable: res.cdpFallbackAvailable === true },
      });
    }
    if (res?.success === false) {
      throw Object.assign(new Error(res.error || 'Screenshot failed'), { code: res.code || 'E_COMMAND_FAILED' });
    }
    if (typeof res?.imageData !== 'string' || !res.imageData) {
      throw Object.assign(new Error('No image data received from browser'), { code: 'E_INTERNAL' });
    }

    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, Buffer.from(res.imageData, 'base64'));
    return {
      saved: true,
      filePath: savePath,
      fileName,
      url: res.url || res.tabUrl || req.params?.url,
      tabId: res.tabId ?? req.params?.tabId,
      tabTitle: res.tabTitle,
      capturedVia: res.capturedVia || 'activeTab',
    };
  }

  async dispatch(req: AgentRequest): Promise<AgentResponse> {
    const correlationId = `snu_req_${req.id}_${Date.now()}`;
    this.requestIdToCorrelationId.set(req.id, correlationId);
    const policy = getCommandPolicy(req);

    try {
      // 1. Connection Commands
      if (req.command === 'check_connection') {
        const isRunning = this.ws.isServerRunning();
        const hasBrowser = this.ws.hasBrowserClient();
        const state = this.ws.getHelperState();
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            serverRunning: isRunning,
            browserConnected: hasBrowser,
            helper: hasBrowser
              ? {
                  tier: state.tier,
                  proFeatures: state.proFeatures,
                  cdp: state.cdp,
                  capabilities: state.capabilities,
                }
              : null,
          },
        };
      }

      // The one question local state cannot answer: does ServiceNow still
      // accept this session? Mirrors the extension's auth_status so the same
      // CLI command means the same thing on both hosts — the CLI and the
      // extension diverging on a shared command is how the scope defect hid.
      if (req.command === 'auth_status') {
        const inst = this.resolveInstance(req.instance);
        const origin = (() => {
          try { return inst.settings?.url ? new URL(inst.settings.url).origin.toLowerCase() : null; }
          catch { return null; }
        })();
        const base = { instance: inst.name, origin };
        const reply = (result: Record<string, any>) => ({
          id: req.id,
          command: req.command,
          status: 'success' as const,
          timestamp: Date.now(),
          result: { ...base, ...result },
        });

        if (!inst.settings?.url) {
          return reply({ ok: false, state: 'INSTANCE_NOT_FOUND', message: `No settings for instance '${inst.name}'.` });
        }
        if (!this.ws.hasBrowserClient()) {
          return reply({
            ok: false,
            state: 'HELPER_DISCONNECTED',
            message: 'The SN Utils helper tab is not connected, so the session cannot be checked.',
          });
        }

        const hasLiveSession = !!origin && this.ws.getLiveInstances().some((live) => {
          try { return new URL(live.url).origin.toLowerCase() === origin; } catch { return false; }
        });
        if (!inst.settings?.g_ck) {
          const verdict = classifyProbe({ error: 'Missing instance URL or authentication token', origin, hasLiveSession });
          return reply({ ok: false, state: verdict.state, message: verdict.message });
        }

        const correlationId = crypto.randomUUID();
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 15_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: '/api/now/table/sys_user',
          method: 'GET',
          queryParams: { sysparm_limit: '1', sysparm_fields: 'sys_id', sysparm_no_count: 'true' },
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });

        try {
          const res: any = await pendingPromise;
          // 401 and 403 mean opposite things: the session is gone, versus the
          // session authenticated and an ACL refused the row. Failures without
          // a status are classified from the helper tab's own error text.
          const verdict = res?.success === false
            ? classifyProbe({ status: res?.status, error: typeof res?.error === 'string' ? res.error : res?.error?.message, origin, hasLiveSession })
            : classifyProbe({ status: 200, origin, hasLiveSession });
          return reply({
            ok: verdict.state === 'AUTH_OK',
            state: verdict.state,
            message: verdict.message,
            detail: res?.error,
          });
        } catch (err: any) {
          const verdict = classifyProbe({ status: err?.details?.status, error: err?.message || String(err), origin, hasLiveSession });
          return reply({
            ok: false,
            state: verdict.state,
            message: verdict.message,
            detail: err?.message || String(err),
          });
        }
      }

      if (req.command === 'list_instances') {
        const folders = this.listInstanceFolders();
        const now = Date.now();
        const instances: Array<{
          name: string;
          url: string | null;
          hasSettings: boolean;
          recentlyActive: boolean;
          lastActiveAgeMs: number | null;
          source: 'workspace' | 'browser';
        }> = folders.map((f) => {
          const name = path.basename(f);
          const settings = this.getInstanceSettings(name) || {};
          let lastActiveAgeMs: number | null = null;
          try {
            const mtime = fs.statSync(path.join(f, '_settings.json')).mtimeMs;
            lastActiveAgeMs = Math.max(0, now - mtime);
          } catch {}
          return {
            name,
            url: settings.url || null,
            hasSettings: !!settings.url,
            recentlyActive: lastActiveAgeMs !== null && lastActiveAgeMs < 10 * 3600 * 1000,
            lastActiveAgeMs,
            source: 'workspace' as const,
          };
        });

        for (const live of this.ws.getLiveInstances()) {
          const origin = new URL(live.url).origin.toLowerCase();
          const duplicate = instances.some((instance) => {
            try { return instance.url ? new URL(instance.url).origin.toLowerCase() === origin : false; } catch { return false; }
          });
          if (!duplicate) {
            const lastActiveAgeMs = Math.max(0, now - live.lastActiveAt);
            instances.push({
              name: live.name,
              url: live.url,
              hasSettings: true,
              recentlyActive: true,
              lastActiveAgeMs,
              source: 'browser',
            });
          }
        }

        instances.sort((a, b) => {
          if (a.lastActiveAgeMs === null) return 1;
          if (b.lastActiveAgeMs === null) return -1;
          return a.lastActiveAgeMs - b.lastActiveAgeMs;
        });

        const liveDefault = this.ws.getLiveInstances()[0]?.name;
        const recent = instances.filter((i) => i.recentlyActive);
        const defaultInstance = liveDefault || (recent.length === 1 ? recent[0].name : (instances[0]?.name || null));

        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            instances,
            count: instances.length,
            connected: this.ws.hasBrowserClient(),
            defaultInstance,
            needsConfirmation: false,
          },
        };
      }

      if (req.command === 'get_instance_info') {
        const inst = this.resolveInstance(req.instance);
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            instanceName: inst.name,
            hasSettings: !!inst.settings?.url,
            connected: this.ws.hasBrowserClient(),
          },
        };
      }

      if (req.command === 'get_capabilities') {
        const state = this.ws.getHelperState();
        const instanceGatesRecord: Record<string, any> = {};
        for (const [origin, snap] of state.instanceGates.entries()) {
          instanceGatesRecord[origin] = snap;
        }

        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            apiVersion: AGENT_API_VERSION,
            tier: state.tier,
            proFeatures: state.proFeatures,
            cdp: state.cdp,
            gates: this.config.gates,
            instanceGates: instanceGatesRecord,
            capabilities: state.capabilities,
          },
        };
      }

      // Check browser connection for all instance/remote commands. Not a
      // failure of the tool: a user-actionable setup state, so ship guidance
      // steps in details for the CLI and MCP surfaces to render.
      if (!this.ws.hasBrowserClient()) {
        throw Object.assign(new Error('ServiceNow is not connected: the SN Utils helper tab is not open.'), {
          code: 'E_BROWSER_DISCONNECTED',
          details: { guidance: HELPER_CONNECT_GUIDANCE },
        });
      }

      const inst = this.resolveInstance(req.instance);
      const instanceUrl = inst.settings?.url || '';
      const instanceOrigin = instanceUrl ? new URL(instanceUrl).origin.toLowerCase() : '';

      // 2. Authoritative Security Gate Evaluation (Deny-Wins)
      for (const gateName of policy.gates) {
        // A. Check Host Gate (Fail-closed standalone authority)
        if (!this.config.gates[gateName]) {
          const label = GATE_LABELS[gateName] || gateName;
          const envVar = GATE_ENV_VARS[gateName];
          throw Object.assign(
            new Error(
              `${label} is disabled in this snu host config, so ${req.command} cannot run. ` +
              `Turn it on with ${envVar}=1 in the MCP server's env block, or "${gateName}": true in ~/.sn-scriptsync/settings.json, then restart snu. ` +
              `This is the user's decision to make: ask them to enable it rather than routing around it through the browser UI.`
            ),
            { code: 'E_DISABLED', details: { gate: gateName, envVar, source: 'host' } }
          );
        }

        // B. Check Helper Instance Gate (if instanceSecurityGates capability is present)
        const helperState = this.ws.getHelperState();
        if (helperState.capabilities?.instanceSecurityGates && instanceOrigin) {
          const helperGateMode = this.ws.getInstanceGate(instanceUrl, gateName);
          if (helperGateMode === 'off' || helperGateMode === false) {
            const label = GATE_LABELS[gateName] || gateName;
            throw Object.assign(
              new Error(
                `This instance (${instanceOrigin}) does not permit ${label} in the SN Utils helper, so ${req.command} cannot run. ` +
                `The user can turn it on in the helper tab's Agent Access tab for this instance. ` +
                `This is the user's decision to make: ask them to enable it rather than routing around it through the browser UI.`
              ),
              { code: 'E_DISABLED', details: { gate: gateName, instanceOrigin, source: 'instance' } }
            );
          }
        }
      }

      // 3. Two-Phase Human Review Enforcement (when supported by connected helper)
      const helperState = this.ws.getHelperState();
      let isReviewRequired = policy.review === 'required' && this.config.reviewHighRisk;
      if (helperState.capabilities?.instanceSecurityGates && instanceOrigin) {
        for (const gateName of policy.gates) {
          const gateMode = this.ws.getInstanceGate(instanceUrl, gateName);
          if (gateMode === 'auto') {
            isReviewRequired = false;
          } else if (gateMode === 'approve') {
            isReviewRequired = true;
          }
        }
      }
      // Positive capability detection: helpers in the wild predate the review
      // protocol and send no capabilities at all, so only an explicit
      // commandReview: 1 opts into the review round-trip. Everything else falls
      // through to direct execution, still behind the fail-closed host gates.
      const hasCommandReview = this.ws.hasBrowserClient() && helperState.capabilities?.commandReview === 1;

      if (isReviewRequired && hasCommandReview) {
        const reviewId = `rev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const serverNonce = crypto.randomBytes(16).toString('hex');
        const payloadHash = computePayloadHash(1, instanceOrigin, req.command, req.params);

        this.ws.registerReview({
          reviewId,
          nonce: serverNonce,
          payloadHash,
          correlationId,
          command: req.command,
          params: req.params,
          instanceOrigin,
        });
        this.pendingReviewRequests.set(correlationId, reviewId);
        this.pendingReviewRequests.set(req.id, reviewId);

        // Send Phase 1 reviewRequest to browser
        const reviewTimeoutMs = 300_000; // 5 minutes
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: reviewTimeoutMs });

        this.ws.sendToBrowser({
          action: 'reviewRequest',
          reviewId,
          nonce: serverNonce,
          payloadHash,
          reviewKind: policy.reviewKind,
          risk: policy.risk,
          command: req.command,
          params: req.params,
          instanceOrigin,
          instance: inst.settings,
          client: {
            name: 'SN Utils CLI',
            version: '0.1.0',
            hostKind: 'standalone',
            pid: process.pid,
          },
          expiresIn: Math.floor(reviewTimeoutMs / 1000),
          agentRequestId: correlationId,
        });

        try {
          const res = await pendingPromise;
          // approvedNotExecuted: the helper approved but cannot run this
          // command shape (bulk delete by query, REST DELETE, cascade) — fall
          // through to the direct execution branches below.
          if (res?.approvedNotExecuted !== true) {
            return {
              id: req.id,
              command: req.command,
              status: 'success',
              timestamp: Date.now(),
              result: res.output !== undefined ? { output: res.output } : res.data || res.result || { success: true },
            };
          }
        } finally {
          this.pendingReviewRequests.delete(correlationId);
          this.pendingReviewRequests.delete(req.id);
          this.ws.cancelReview(reviewId, 'COMPLETED_OR_TIMED_OUT');
        }
      }

      // 4. Standard Direct Execution (Unreviewed commands + legacy helper fallback)

      // Background Script
      if (req.command === 'run_background_script') {
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRunBackgroundScript',
          agentRequestId: correlationId,
          script: req.params?.script,
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Background script failed'), { code: res.code || 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: { output: res.output || '' },
        };
      }

      // Delete Record
      if (req.command === 'delete_record') {
        const { table, sys_id } = req.params || {};
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}/${sys_id}`,
          method: 'DELETE',
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Delete failed'), { code: res.code || 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: { deleted: true, table, sys_id },
        };
      }

      // Code Search (GraphQL)
      if (req.command === 'code_search') {
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentCodeSearch',
          agentRequestId: correlationId,
          term: req.params?.term,
          tables: req.params?.tables,
          limit: req.params?.limit ?? 50,
          activeOnly: req.params?.activeOnly === true,
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Code search failed'), { code: res.code || 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: res,
        };
      }

      // Query Records (Table API)
      if (req.command === 'query_records') {
        const table = req.params?.table;
        const query = req.params?.query || '';
        const fields = req.params?.fields || 'sys_id,number,short_description,sys_created_on';
        const limit = req.params?.limit ?? 10;
        const orderBy = req.params?.orderBy;

        let sysparmQuery = query;
        if (orderBy) {
          sysparmQuery = sysparmQuery ? `${sysparmQuery}` + (sysparmQuery ? '^' : '') + `${orderBy}` : orderBy;
        }

        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}`,
          method: 'GET',
          queryParams: {
            sysparm_query: sysparmQuery,
            sysparm_fields: fields,
            sysparm_limit: String(limit),
            sysparm_display_value: 'true',
          },
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Query failed'), { code: res.status === 404 ? 'E_NOT_FOUND' : 'E_COMMAND_FAILED' });
        }
        const records = res.data?.result || [];
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            table,
            count: records.length,
            records,
          },
        };
      }

      // Get Record
      if (req.command === 'get_record') {
        const table = req.params?.table;
        const sysId = req.params?.sys_id;
        const fields = req.params?.fields;

        const queryParams: Record<string, string> = { sysparm_display_value: 'true' };
        if (fields) queryParams.sysparm_fields = fields;

        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}/${sysId}`,
          method: 'GET',
          queryParams,
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || `Record ${sysId} not found`), { code: res.status === 404 ? 'E_NOT_FOUND' : 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            table,
            sys_id: sysId,
            record: res.data?.result,
          },
        };
      }

      // Update Record
      if (req.command === 'update_record') {
        const { table, sys_id, field, content } = req.params || {};
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}/${sys_id}`,
          method: 'PATCH',
          body: { [field]: content },
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Update failed'), { code: 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            updated: true,
            table,
            sys_id,
            field,
            record: res.data?.result,
          },
        };
      }

      // Create Artifact
      if (req.command === 'create_artifact') {
        const { table, fields } = req.params || {};
        // Scoped creates need both the row's sys_scope and a matching
        // transaction scope, or the instance refuses the insert with the
        // cross-scope security-constraint 403.
        const scopeResolution = await this.resolveScopeForCreate(inst, req.params?.scope, fields);
        const scopeSysId = scopeResolution.sysScopeId;
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}`,
          method: 'POST',
          body: scopeSysId ? { ...fields, sys_scope: scopeSysId } : fields,
          ...(scopeSysId ? { queryParams: { sysparm_transaction_scope: scopeSysId } } : {}),
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Create artifact failed'), { code: 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            created: true,
            table,
            name: fields?.name,
            sys_id: res.data?.result?.sys_id,
            record: res.data?.result,
          },
        };
      }

      // Create Record (plain data row). Same insert as create_artifact minus the
      // name requirement and the local _map.json tracking, which only makes
      // sense for artifacts that have a file in the workspace.
      if (req.command === 'create_record') {
        const rawTable = req.params?.table;
        if (!rawTable || typeof rawTable !== 'string' || !/^[a-zA-Z0-9_]+$/.test(rawTable.trim())) {
          throw Object.assign(new Error('Missing or invalid param "table" (must be alphanumeric/underscore)'), { code: 'E_INVALID_PARAMS' });
        }
        const table = rawTable.trim();
        const fields = req.params?.fields;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
          throw Object.assign(
            new Error('Missing required param "fields": provide at least one field value for the new record'),
            { code: 'E_INVALID_PARAMS' }
          );
        }

        const wantsScope = req.params?.scope !== undefined || typeof fields?.sys_scope === 'string';
        const scopeResolution = wantsScope
          ? await this.resolveScopeForCreate(inst, req.params?.scope, fields)
          : undefined;
        const scopeSysId = scopeResolution?.sysScopeId;
        const queryParams: Record<string, string> = { sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true' };
        if (scopeSysId) queryParams.sysparm_transaction_scope = scopeSysId;
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}`,
          method: 'POST',
          body: fields,
          queryParams,
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          const message = res.error || `Failed to create a record on ${table}`;
          throw Object.assign(new Error(message), {
            code: res.code || codeForRestStatus(res.status, message),
            details: { status: res.status, detail: res.detail ?? null },
          });
        }

        // POST /api/now/table returns the inserted row, so the write is already
        // verified: no follow-up get_record needed.
        const record = res.data?.result ?? null;
        const readField = (name: string): string => {
          const value = record?.[name];
          if (value && typeof value === 'object') return String(value.value ?? value.display_value ?? '');
          return value === undefined || value === null ? '' : String(value);
        };
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            created: true,
            table,
            sys_id: readField('sys_id'),
            name: readField('number') || readField('name') || readField('sys_name') || readField('short_description'),
            record,
          },
        };
      }

      // Schema Metadata
      if (req.command === 'get_table_metadata') {
        const table = req.params?.table;
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/doc/table/schema/${table}`,
          method: 'GET',
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || `Schema for table ${table} not found`), { code: 'E_NOT_FOUND' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: res.data?.result || res.data,
        };
      }

      // Pull Scope: every scriptable artifact of one application, paged
      if (req.command === 'pull_scope') {
        const rawScope = req.params?.scope;
        if (!rawScope || typeof rawScope !== 'string' || !rawScope.trim()) {
          throw Object.assign(new Error('Missing required param "scope" (application scope name such as x_acme_app, or its sys_scope sys_id)'), { code: 'E_INVALID_PARAMS' });
        }
        const scopeParam = rawScope.trim();
        if (scopeParam === 'global') {
          throw Object.assign(new Error('pull_scope targets one application; the global scope is too large to pull whole. Use pull_records with a query instead.'), { code: 'E_INVALID_PARAMS' });
        }
        if (!/^[A-Za-z0-9_]+$/.test(scopeParam)) {
          throw Object.assign(new Error('Parameter "scope" must be a scope name (letters, digits, underscore) or a 32-character sys_id.'), { code: 'E_INVALID_PARAMS' });
        }
        const PAGE = 100, DEFAULT_LIMIT = 2000, MAX_LIMIT = 10000;
        let limit = DEFAULT_LIMIT;
        if (req.params?.limit !== undefined) {
          if (typeof req.params.limit !== 'number' || !Number.isInteger(req.params.limit) || req.params.limit < 1 || req.params.limit > MAX_LIMIT) {
            throw Object.assign(new Error(`Parameter "limit" must be an integer between 1 and ${MAX_LIMIT} (records per table).`), { code: 'E_INVALID_PARAMS' });
          }
          limit = req.params.limit;
        }
        let tableFilter: Set<string> | null = null;
        if (req.params?.tables !== undefined) {
          const raw = Array.isArray(req.params.tables) ? req.params.tables : (typeof req.params.tables === 'string' ? req.params.tables.split(',') : null);
          if (!raw) throw Object.assign(new Error('Parameter "tables" must be an array of table names.'), { code: 'E_INVALID_PARAMS' });
          tableFilter = new Set<string>();
          for (const t of raw) {
            if (typeof t !== 'string' || !/^[A-Za-z0-9_]+$/.test(t.trim())) {
              throw Object.assign(new Error(`Invalid table name in "tables": ${String(t)}`), { code: 'E_INVALID_PARAMS' });
            }
            tableFilter.add(t.trim());
          }
        }
        const includeRecords = req.params?.includeRecords === true;

        // Resolve the scope: sys_id as given, else scopes.json, else the instance.
        let scopeSysId: string | undefined;
        let scopeName: string | undefined;
        const scopesPath = path.join(this.cwd, inst.name, 'scopes.json');
        let scopes: Record<string, string> = {};
        try { scopes = JSON.parse(fs.readFileSync(scopesPath, 'utf8')) || {}; } catch {}
        if (/^[0-9a-fA-F]{32}$/.test(scopeParam)) {
          scopeSysId = scopeParam.toLowerCase();
          scopeName = Object.keys(scopes).find((k) => String(scopes[k]).toLowerCase() === scopeSysId);
        } else {
          scopeName = scopeParam;
          scopeSysId = scopes[scopeName] ? String(scopes[scopeName]).toLowerCase() : undefined;
        }
        if (!scopeSysId || !scopeName) {
          const data = await this.restGet(inst, req.command, '/api/now/table/sys_scope', {
            sysparm_query: scopeSysId ? `sys_id=${scopeSysId}` : `scope=${scopeName}`,
            sysparm_fields: 'sys_id,scope,name',
            sysparm_limit: '1',
            sysparm_exclude_reference_link: 'true',
            sysparm_no_count: 'true',
          });
          const row = Array.isArray(data?.result) ? data.result[0] : data?.result;
          if (!row?.sys_id) {
            throw Object.assign(new Error(`Application scope "${scopeParam}" was not found on ${inst.name}.`), { code: 'E_NOT_FOUND' });
          }
          scopeSysId = String(typeof row.sys_id === 'object' ? row.sys_id.value : row.sys_id).toLowerCase();
          scopeName = String(typeof row.scope === 'object' ? row.scope.value : row.scope);
          try {
            scopes[scopeName] = scopeSysId;
            fs.mkdirSync(path.dirname(scopesPath), { recursive: true });
            fs.writeFileSync(scopesPath, JSON.stringify(scopes, null, 2));
          } catch {}
        }

        const fetchPage: FetchPage = (table, query) => this.restGet(inst, req.command, `/api/now/table/${table}`, query, true);
        const discovery = await readAllPages(fetchPage, 'sys_metadata', `sys_scope=${scopeSysId}^sys_class_name!=sys_metadata_delete^sys_update_name!=NULL^ORDERBYsys_id`, 'sys_class_name');
        const classCounts = new Map<string, number>();
        for (const row of discovery.rows) {
          const cls = String(typeof row.sys_class_name === 'object' ? row.sys_class_name.value : row.sys_class_name || '');
          if (/^[a-zA-Z0-9_]+$/.test(cls)) classCounts.set(cls, (classCounts.get(cls) || 0) + 1);
        }
        const schema = await discoverScopeFields([...classCounts.keys()], getMetaDataRelations(this.cwd)?.tableFields || {}, fetchPage);
        const tables = [...classCounts.keys()].filter(t => Object.keys(schema.definitions[t]?.codeFields || {}).length && (!tableFilter || tableFilter.has(t))).sort();
        const skippedTables = [...classCounts.keys()].filter(t => !Object.keys(schema.definitions[t]?.codeFields || {}).length).sort()
          .map(table => ({ table, records: classCounts.get(table) || 0, reason: schema.warnings.some(w => w.startsWith(`${table}:`)) ? 'dictionary_unavailable' : 'no_scriptable_fields' }));
        const missingTables = tableFilter ? [...tableFilter].filter((t) => !classCounts.has(t)).sort() : [];

        const perTable: any[] = [];
        const warnings: string[] = [...discovery.warnings, ...schema.warnings];
        let complete = discovery.complete && schema.warnings.length === 0;
        let totalRecords = 0, totalFiles = 0, totalSkippedEmpty = 0, totalSkippedUnreadable = 0;
        for (const table of tables) {
          const fieldDefinitions = schema.definitions[table].codeFields!;
          const codeFields = Object.keys(fieldDefinitions);
          const query = `sys_scope=${scopeSysId}^sys_class_name=${table}^ORDERBYsys_id`;
          const entry: any = { table, matchedRecords: 0, pulledRecords: 0, filesWritten: 0, skippedEmpty: 0, skippedUnreadable: 0, truncated: false };
          if (includeRecords) entry.records = [];
          let reportedTotal: number | undefined;
          for (let offset = 0; ;) {
            const pageLimit = Math.min(PAGE, limit - entry.matchedRecords);
            if (pageLimit <= 0) { entry.truncated = true; break; }
            const page = await this.pullTablePage(inst, req.command, { table, query, codeFields, fieldDefinitions, limit: pageLimit, offset });
            if (page.pagination?.totalCount && /^\d+$/.test(page.pagination.totalCount)) reportedTotal = Number(page.pagination.totalCount);
            entry.matchedRecords += page.matchedRecords;
            entry.pulledRecords += page.pulledRecords;
            entry.filesWritten += page.filesWritten;
            entry.skippedEmpty += page.skippedEmpty;
            entry.skippedUnreadable += page.skippedUnreadable;
            if (includeRecords) entry.records.push(...page.records);
            for (const w of page.warnings) warnings.push(`${table}: ${w}`);
            const paging = pageState(page.pagination, offset, pageLimit, page.matchedRecords);
            if (paging.nextOffset === undefined) {
              complete = complete && paging.complete;
              if (paging.warning) warnings.push(`${table}: ${paging.warning}`);
              break;
            }
            offset = paging.nextOffset;
          }
          if (!entry.truncated && reportedTotal !== undefined && reportedTotal > entry.matchedRecords) warnings.push(`${table}: ${reportedTotal - entry.matchedRecords} matching records were not returned; access controls or changing records may account for the difference.`);
          if (entry.truncated) warnings.push(`${table}: stopped at the per-table limit of ${limit} records; raise "limit" or pull the rest with pull_records.`);
          totalRecords += entry.pulledRecords;
          totalFiles += entry.filesWritten;
          totalSkippedEmpty += entry.skippedEmpty;
          totalSkippedUnreadable += entry.skippedUnreadable;
          perTable.push(entry);
        }
        for (const t of missingTables) warnings.push(`${t}: no records of this table in scope ${scopeName}.`);

        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            complete: complete && !perTable.some(t => t.truncated) && warnings.length === 0,
            metadataRecords: discovery.rows.length,
            scope: { name: scopeName, sys_id: scopeSysId },
            folder: path.join(inst.name, scopeName).replace(/\\/g, '/'),
            tables: perTable,
            totals: { tables: perTable.length, records: totalRecords, filesWritten: totalFiles, skippedEmpty: totalSkippedEmpty, skippedUnreadable: totalSkippedUnreadable },
            skippedTables,
            warnings,
          },
        };
      }

      // Pull Records / Pull Artifacts
      if (req.command === 'pull_records' || req.command === 'pull_artifacts') {
        const rawTable = req.params?.table;
        if (!rawTable || typeof rawTable !== 'string' || !/^[a-zA-Z0-9_]+$/.test(rawTable.trim())) {
          throw Object.assign(new Error('Missing or invalid required param "table" (must be alphanumeric/underscore)'), { code: 'E_INVALID_PARAMS' });
        }
        const table = rawTable.trim();

        let limit = 50;
        if (req.params?.limit !== undefined) {
          if (typeof req.params.limit !== 'number' || !Number.isInteger(req.params.limit) || req.params.limit < 1 || req.params.limit > 500) {
            throw Object.assign(new Error('Parameter "limit" must be an integer between 1 and 500.'), { code: 'E_INVALID_PARAMS' });
          }
          limit = req.params.limit;
        }

        // Normalize & validate sys_ids
        const rawIds: string[] = [];
        if (typeof req.params?.sys_id === 'string' && req.params.sys_id.trim()) {
          rawIds.push(req.params.sys_id.trim());
        }
        if (Array.isArray(req.params?.sys_ids)) {
          for (const id of req.params.sys_ids) {
            if (typeof id === 'string' && id.trim()) rawIds.push(id.trim());
          }
        }
        const validHexOrGlobal = /^(?:[0-9a-fA-F]{32}|global)$/;
        const normalizedIds = Array.from(new Set(rawIds.map((id) => id.toLowerCase())));
        for (const id of normalizedIds) {
          if (!validHexOrGlobal.test(id)) {
            throw Object.assign(new Error(`Invalid sys_id "${id}". Must be a 32-character hexadecimal string or 'global'.`), { code: 'E_INVALID_PARAMS' });
          }
        }

        // Selection combination with ^ (AND)
        const queryParts: string[] = [];
        if (normalizedIds.length === 1) {
          queryParts.push(`sys_id=${normalizedIds[0]}`);
        } else if (normalizedIds.length > 1) {
          queryParts.push(`sys_idIN${normalizedIds.join(',')}`);
        }
        if (typeof req.params?.query === 'string' && req.params.query.trim()) {
          queryParts.push(req.params.query.trim());
        }
        const combinedQuery = queryParts.join('^');

        // Resolve code fields
        let codeFields: string[] = [];
        if (Array.isArray(req.params?.fields)) {
          codeFields = req.params.fields.filter((f: any) => typeof f === 'string' && /^[a-zA-Z0-9_]+$/.test(f.trim())).map((f: string) => f.trim());
        } else if (typeof req.params?.field === 'string' && /^[a-zA-Z0-9_]+$/.test(req.params.field.trim())) {
          codeFields = [req.params.field.trim()];
        }
        if (codeFields.length === 0) {
          codeFields = resolveTableCodeFields(table, this.cwd);
        }

        const result = await this.pullTablePage(inst, req.command, { table, query: combinedQuery, codeFields, limit, offset: 0 });
        return { id: req.id, command: req.command, status: 'success', timestamp: Date.now(), result };
      }

      // Generic REST passthrough. The escape hatch the typed commands are built
      // on: the browser helper's agentRestApi action has always accepted every
      // method plus a body, so this needs no extension-side change. Gating is
      // handled above by getCommandPolicy (GET open, POST/PUT/PATCH behind
      // restRequest, DELETE behind deleteRecords).
      if (req.command === 'rest_request') {
        const endpoint = req.params?.endpoint;
        if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
          throw Object.assign(
            new Error("Missing/invalid 'endpoint' (must be an instance-relative path beginning with '/', e.g. /api/now/table/incident)"),
            { code: 'E_INVALID_PARAMS' }
          );
        }
        const method = String(req.params?.method || 'GET').toUpperCase();
        if (!REST_METHODS.includes(method)) {
          throw Object.assign(new Error(`Invalid method. Must be one of: ${REST_METHODS.join(', ')}`), { code: 'E_INVALID_PARAMS' });
        }

        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint,
          method,
          body: req.params?.body,
          queryParams: req.params?.queryParams && typeof req.params.queryParams === 'object' ? req.params.queryParams : undefined,
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          const message = res.error || 'REST request failed';
          throw Object.assign(new Error(message), {
            code: res.code || codeForRestStatus(res.status, message),
            details: { status: res.status, detail: res.detail ?? null },
          });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: { status: res.status, data: res.data },
        };
      }

      if (req.command === 'take_screenshot') {
        const result = await this.captureScreenshot(req, correlationId);
        return { id: req.id, command: req.command, status: 'success', timestamp: Date.now(), result };
      }

      // Session context switch: the helper PUTs to the same concourse picker
      // endpoint the header pickers use, so no form is driven. Needs the
      // instance session (url + g_ck), which is why it is not in the generic
      // browser relay below.
      if (req.command === 'switch_context') {
        const rawType = String(req.params?.switchType || '').trim().toLowerCase();
        const switchType = SWITCH_CONTEXT_ALIASES[rawType] || rawType;
        if (!SWITCH_CONTEXT_TYPES.includes(switchType)) {
          throw Object.assign(
            new Error(`Missing or invalid switchType. Must be one of: ${SWITCH_CONTEXT_TYPES.join(', ')}`),
            { code: 'E_INVALID_PARAMS' }
          );
        }
        const value = String(req.params?.value ?? req.params?.sysId ?? req.params?.sys_id ?? '').trim();
        if (!value || /[\s\0]/.test(value)) {
          throw Object.assign(
            new Error('Missing required param: value (sys_id of the update set, application or domain)'),
            { code: 'E_INVALID_PARAMS' }
          );
        }
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: BROWSER_ACTIONS.switch_context,
          agentRequestId: correlationId,
          switchType,
          value,
          reloadTab: req.params?.reloadTab !== false,
          tabUrl: typeof req.params?.tabUrl === 'string' && req.params.tabUrl ? req.params.tabUrl : 'https://*.service-now.com/*',
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res?.success === false) {
          throw Object.assign(new Error(res.error || `Could not switch ${switchType}`), { code: res.code || 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            switched: true,
            switchType: res?.switchType || switchType,
            value: res?.value || value,
            reloaded: res?.reloaded === true,
          },
        };
      }

      // Browser Form & UI Actions
      if (['get_form_state', 'set_field', 'run_ui_action', 'navigate'].includes(req.command)) {
        const action = BROWSER_ACTIONS[req.command as keyof typeof BROWSER_ACTIONS];
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action,
          agentRequestId: correlationId,
          ...req.params,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || `Browser command ${req.command} failed`), { code: res.code || 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: res,
        };
      }

      throw Object.assign(new Error(`Unknown command: ${req.command}`), { code: 'E_UNKNOWN_COMMAND' });
    } catch (err: any) {
      this.pendingReviewRequests.delete(correlationId);
      this.pendingReviewRequests.delete(req.id);
      return {
        id: req.id,
        command: req.command,
        status: 'error',
        error: err.message || String(err),
        code: err.code || 'E_COMMAND_FAILED',
        timestamp: Date.now(),
        details: err.details,
      };
    } finally {
      this.requestIdToCorrelationId.delete(req.id);
    }
  }
}
