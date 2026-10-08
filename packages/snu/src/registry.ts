import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, MappedCommand } from './types.js';
import { findNowSdkProjects, readDeployLink } from './nowsdk/NowSdkProject.js';
import { resolveFieldValues } from './fieldInput.js';

/**
 * The instance a NOW SDK app is linked to (.snu/deploy.json), so deploy and
 * pull use the same instance as the editor when none is given. Resolved from
 * this process's folder; undefined when there is no single project or link.
 */
function linkedSdkInstance(projectPath?: string): string | undefined {
  try {
    const base = process.cwd();
    let root: string | undefined;
    if (projectPath) {
      const abs = path.resolve(base, projectPath);
      root = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } else {
      const found = findNowSdkProjects(base);
      root = found.length === 1 ? found[0] : undefined;
    }
    return root ? readDeployLink(root)?.instance : undefined;
  } catch {
    return undefined;
  }
}

const sdkProjectPath = (input: Record<string, any>) =>
  typeof input.projectPath === 'string' && input.projectPath ? input.projectPath : undefined;

function formatOrderBy(orderBy?: string): string | undefined {
  if (!orderBy) return undefined;
  const trimmed = orderBy.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('ORDERBY')) return trimmed;
  return `ORDERBY${trimmed}`;
}

function parseQueryPairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

export const TOOLS: ToolDefinition[] = [
  // 1. Code Search
  {
    name: 'snu_code_search',
    agentCommand: 'code_search',
    description:
      'Fast SN Utils GraphQL field-index code search across Script Includes, Business Rules, Client Scripts, UI Actions, and Flow Actions. Requires SN Utils Pro.',
    cliCommand: 'search',
    cliUsage: 'snu search <term> [--tables <t1,t2>] [--limit <n>] [--active-only] [--instance <i>] [--json]',
    cliOptions: {
      tables: { type: 'string', short: 't', description: 'Comma-separated table filter' },
      limit: { type: 'string', short: 'l', description: 'Max results (default: 50)' },
      'active-only': { type: 'boolean', short: 'a', description: 'Search active records only' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'Search keyword or phrase (min 2 chars)' },
        tables: { type: 'string', description: 'Optional comma-separated table names to filter search' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Max hits to return' },
        activeOnly: { type: 'boolean', default: false, description: 'Only search active records' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['term'],
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'code_search',
      instance: input.instance,
      params: {
        term: input.term,
        tables: input.tables,
        limit: typeof input.limit === 'number' ? input.limit : input.limit ? parseInt(input.limit, 10) : 50,
        activeOnly: input.activeOnly === true || input['active-only'] === true,
      },
    }),
  },

  // 2. Schema
  {
    name: 'snu_get_schema',
    agentCommand: 'get_table_metadata',
    description:
      'Fetch column dictionary metadata for a table (types, labels, references, choice lists, mandatory/read-only flags).',
    cliCommand: 'schema',
    cliUsage: 'snu schema <table> [--instance <i>] [--json]',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'ServiceNow table name (e.g. incident, sys_user)' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'get_table_metadata',
      instance: input.instance,
      params: {
        table: input.table,
      },
    }),
  },

  // 3. Context
  {
    name: 'snu_get_context',
    agentCommand: 'get_context',
    description:
      'Inspect active ServiceNow connection status, helper tab state, license tier, available instances, and permission gates.',
    cliCommand: 'context',
    cliUsage: 'snu context [--instance <i>] [--json]',
    inputSchema: {
      type: 'object',
      properties: {
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'get_context',
      instance: input.instance,
      params: {},
    }),
  },

  // 4. Query Records
  {
    name: 'snu_query_records',
    agentCommand: 'query_records',
    description: 'Query records from any ServiceNow table with an encoded query string, projection fields, and limit.',
    cliCommand: 'query',
    cliUsage: 'snu query <table> [query] [--fields <f1,f2>] [--limit <n>] [--order-by <field>] [--instance <i>] [--json]',
    cliOptions: {
      fields: { type: 'string', short: 'f', description: 'Fields to project (default: sys_id,number,short_description,sys_created_on)' },
      limit: { type: 'string', short: 'l', description: 'Max records to return (default: 10)' },
      'order-by': { type: 'string', short: 'o', description: 'Order by field expression' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name to query' },
        query: { type: 'string', description: 'ServiceNow encoded query string (e.g. active=true^priority=1)' },
        fields: { type: 'string', description: 'Comma-separated field list to project' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 10, description: 'Max records to return' },
        orderBy: { type: 'string', description: 'Order by field expression (e.g. sys_created_on or ORDERBYDESCsys_created_on)' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'query_records',
      instance: input.instance,
      params: {
        table: input.table,
        query: input.query || '',
        fields: input.fields || 'sys_id,number,short_description,sys_created_on',
        limit: typeof input.limit === 'number' ? input.limit : input.limit ? parseInt(input.limit, 10) : 10,
        orderBy: formatOrderBy(input.orderBy || input['order-by']),
      },
    }),
  },

  // 5. Pull Records
  {
    name: 'snu_pull_records',
    agentCommand: 'pull_records',
    description:
      'Pull records from ServiceNow and store code fields into canonical local workspace files with _map.json tracking.',
    cliCommand: 'pull',
    cliUsage: 'snu pull <table> [query] [--sys-id <id>] [--fields <f1,f2>] [--limit <n>] [--instance <i>] [--json]',
    cliOptions: {
      query: { type: 'string', short: 'q', description: 'Encoded query string' },
      'sys-id': { type: 'string', short: 's', description: 'Specific record sys_id' },
      fields: { type: 'string', short: 'f', description: 'Comma-separated field list to pull' },
      limit: { type: 'string', short: 'l', description: 'Max records to return (default: 50)' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name to pull from (e.g. sys_script, sys_script_include, sp_widget)' },
        query: { type: 'string', description: 'ServiceNow encoded query string (optional)' },
        sys_id: { type: 'string', description: 'Specific record sys_id to pull (optional)' },
        fields: { type: 'string', description: 'Comma-separated field list to project (optional)' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Max records to pull' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'pull_records',
      instance: input.instance,
      params: {
        table: input.table,
        query: input.query,
        sys_id: input.sys_id || input['sys-id'],
        fields: typeof input.fields === 'string' ? input.fields.split(',').map((s: string) => s.trim()) : undefined,
        limit: typeof input.limit === 'number' ? input.limit : input.limit ? parseInt(input.limit, 10) : 50,
      },
    }),
  },

  // 5b. Pull Scope
  {
    name: 'snu_pull_scope',
    agentCommand: 'pull_scope',
    description:
      'Pull every scriptable artifact of one application scope into canonical local workspace files (paged past the Table API limits, refreshable). Use pull_records for global or ad-hoc selections.',
    cliCommand: 'pull-scope',
    cliUsage: 'snu pull-scope <scope> [--tables <t1,t2>] [--limit <n>] [--instance <i>] [--json]',
    cliOptions: {
      tables: { type: 'string', short: 't', description: 'Comma-separated table filter' },
      limit: { type: 'string', short: 'l', description: 'Max records per table (default: 2000)' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Application scope name (x_acme_app) or sys_scope sys_id. "global" is refused.' },
        tables: { type: 'string', description: 'Comma-separated table filter (optional)' },
        limit: { type: 'integer', minimum: 1, maximum: 10000, default: 2000, description: 'Max records per table' },
        includeRecords: { type: 'boolean', default: false, description: 'Return the per-record file list for each table' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'pull_scope',
      instance: input.instance,
      params: {
        scope: input.scope,
        tables: typeof input.tables === 'string' ? input.tables.split(',').map((s: string) => s.trim()).filter(Boolean) : (Array.isArray(input.tables) ? input.tables : undefined),
        limit: typeof input.limit === 'number' ? input.limit : input.limit ? parseInt(input.limit, 10) : undefined,
        includeRecords: input.includeRecords === true || input['include-records'] === true,
      },
    }),
  },

  // 6. Get Record
  {
    name: 'snu_get_record',
    agentCommand: 'get_record',
    description: 'Fetch a single record by sys_id with optional field projection.',
    cliCommand: 'record get',
    cliUsage: 'snu record get <table> <sys_id> [--fields <f1,f2>] [--instance <i>] [--json]',
    cliOptions: {
      fields: { type: 'string', short: 'f', description: 'Comma-separated field list' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name' },
        sys_id: { type: 'string', description: '32-character record sys_id' },
        fields: { type: 'string', description: 'Comma-separated field list (optional)' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['table', 'sys_id'],
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'get_record',
      instance: input.instance,
      params: {
        table: input.table,
        sys_id: input.sys_id,
        fields: input.fields,
      },
    }),
  },

  // 6. Create Artifact
  {
    name: 'snu_create_artifact',
    agentCommand: 'create_artifact',
    description:
      'Create a scriptable artifact (Script Include, Business Rule, UI Action, etc.) through the createArtifacts gate. Pass scope when the application is known, or "global" for Global; omitting scope uses the session\'s current application. Supply fields directly or read a JSON object from fieldsFile inside the local workspace. Use snu_create_record for ordinary data rows. The VS Code host also tracks the artifact locally and can stage the write for review.',
    cliCommand: 'artifact create',
    cliUsage: 'snu artifact create <table> <name> [--fields <json> | --file <json-file> | stdin] [--scope <scope>] [--instance <i>] [--json]',
    cliOptions: {
      fields: { type: 'string', short: 'f', description: 'JSON payload dictionary' },
      file: { type: 'string', description: 'Read the field-value JSON object from a file' },
      scope: { type: 'string', short: 's', description: 'Application scope name or sys_id, or "global". Omit to use the session\'s current application.' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Target ServiceNow artifact table (e.g. sys_script_include)' },
        name: { type: 'string', description: 'Artifact name (will be mapped into fields.name)' },
        fields: { type: 'object', description: 'Additional field-value dictionary' },
        fieldsFile: { type: 'string', description: 'JSON file of field values inside the local CLI/MCP workspace; conflicts with fields' },
        scope: { type: 'string', description: 'Application scope name or sys_id, or "global". Optional: omit to create in the session\'s current application. Check the inserted record\'s sys_scope in the result.' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['table', 'name'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      const fields = resolveFieldValues(input);
      return {
        command: 'create_artifact',
        instance: input.instance,
        params: {
          table: input.table,
          fields: { ...fields, name: input.name },
          scope: input.scope,
          await: true,
        },
      };
    },
  },

  // 7. Update Record
  {
    name: 'snu_update_record',
    agentCommand: 'update_record',
    description:
      'Update a field on an existing ServiceNow record with synchronous persistence verification. Covered by the updateRecords permission, which is on by default and follows createArtifacts where it is not set on its own. Note: If review mode is enabled in VS Code settings, the write is staged for manual approval rather than applied immediately.',
    cliCommand: 'record update',
    cliUsage: 'snu record update <table> <sys_id> <field> (--value <v> | --file <path> | stdin) [--instance <i>] [--json]',
    cliOptions: {
      value: { type: 'string', short: 'v', description: 'New field content' },
      file: { type: 'string', short: 'f', description: 'Read new field content from local file' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name' },
        sys_id: { type: 'string', description: 'Record sys_id' },
        field: { type: 'string', description: 'Field name to update (e.g. script, short_description)' },
        value: { type: 'string', description: 'New field content' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['table', 'sys_id', 'field', 'value'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      const content = input.content !== undefined ? input.content : input.value;
      if (content === undefined) {
        throw new Error('Missing required field content (value)');
      }
      return {
        command: 'update_record',
        instance: input.instance,
        params: {
          table: input.table,
          sys_id: input.sys_id,
          field: input.field,
          content,
          await: true,
        },
      };
    },
  },

  // 8. Delete Record
  {
    name: 'snu_delete_record',
    agentCommand: 'delete_record',
    description:
      'Delete a single record from ServiceNow by sys_id. Destructive: disabled by default (deleteRecords.enabled) and requires confirm: true or dryRun: true.',
    cliCommand: 'record delete',
    cliUsage: 'snu record delete <table> <sys_id> [--confirm] [--dry-run] [--instance <i>] [--json]',
    cliOptions: {
      confirm: { type: 'boolean', description: 'Must be set to true to execute deletion' },
      'dry-run': { type: 'boolean', description: 'Return target record without deleting' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name' },
        sys_id: { type: 'string', description: 'Record sys_id' },
        confirm: { type: 'boolean', const: true, description: 'Must be set to true to execute deletion' },
        dryRun: { type: 'boolean', description: 'When true, returns the record that would be deleted without deleting it' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['table', 'sys_id'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      const isDryRun = input.dryRun === true || input['dry-run'] === true;
      if (!isDryRun && input.confirm !== true) {
        throw new Error('snu_delete_record is destructive: pass --confirm to execute or --dry-run to inspect the target record.');
      }
      return {
        command: 'delete_record',
        instance: input.instance,
        params: {
          table: input.table,
          sys_id: input.sys_id,
          dryRun: isDryRun,
        },
      };
    },
  },

  // 9. Run Background Script
  {
    name: 'snu_run_background_script',
    agentCommand: 'run_background_script',
    description:
      'Execute server-side JavaScript on the instance via Background Scripts and return captured output. Gated by backgroundScripts.enabled.',
    cliCommand: 'run',
    cliUsage: 'snu run [script] [--file <path>] [--instance <i>] [--json]',
    cliOptions: {
      file: { type: 'string', short: 'f', description: 'Path to local JS script file' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript code to execute on the instance' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['script'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      if (!input.script) {
        throw new Error('Missing required parameter: script');
      }
      return {
        command: 'run_background_script',
        instance: input.instance,
        params: {
          script: input.script,
        },
      };
    },
  },

  // 10. Get Form State
  {
    name: 'snu_get_form_state',
    agentCommand: 'get_form_state',
    description:
      'Read live form table, sys_id, new-record state, and field values from the active connected ServiceNow browser tab.',
    cliCommand: 'browser form',
    cliUsage: 'snu browser form [--fields <f1,f2>] [--url <u>] [--tab <id>] [--instance <i>] [--json]',
    cliOptions: {
      fields: { type: 'string', short: 'f', description: 'Comma-separated field names to read' },
      url: { type: 'string', description: 'Target tab URL pattern' },
      tab: { type: 'string', description: 'Browser tab ID' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: { type: 'string' }, description: 'Optional list of specific field names to read' },
        url: { type: 'string', description: 'Target tab URL pattern (optional)' },
        tabId: { type: 'integer', description: 'Specific browser tab ID (optional)' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      additionalProperties: false,
    },
    mapInput: (input) => {
      let fields = input.fields;
      if (typeof fields === 'string') {
        fields = fields.split(',').map((f: string) => f.trim()).filter(Boolean);
      }
      const tabId = input.tabId ?? (input.tab ? parseInt(input.tab, 10) : undefined);
      return {
        command: 'get_form_state',
        instance: input.instance,
        params: {
          fields,
          url: input.url,
          tabId,
        },
      };
    },
  },

  // 11. Set Form Field
  {
    name: 'snu_set_form_field',
    agentCommand: 'set_field',
    description:
      'Set a field value on the active ServiceNow form via g_form.setValue (triggers client scripts and UI policies).',
    cliCommand: 'browser set',
    cliUsage: 'snu browser set <field> <value> [--display-value <v>] [--focus] [--url <u>] [--tab <id>] [--instance <i>] [--json]',
    cliOptions: {
      'display-value': { type: 'string', short: 'd', description: 'Display value for reference fields' },
      focus: { type: 'boolean', description: 'Bring the browser tab to the front' },
      url: { type: 'string', description: 'Target tab URL pattern' },
      tab: { type: 'string', description: 'Browser tab ID' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Field name to set' },
        value: { type: 'string', description: 'New value to set' },
        displayValue: { type: 'string', description: 'Optional display value for reference fields' },
        url: { type: 'string', description: 'Target tab URL pattern (optional)' },
        tabId: { type: 'integer', description: 'Specific browser tab ID (optional)' },
        focus: { type: 'boolean', default: false, description: 'Bring the browser tab to the front. By default the tab stays in the background so the user can keep working' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['field', 'value'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      const tabId = input.tabId ?? (input.tab ? parseInt(input.tab, 10) : undefined);
      return {
        command: 'set_field',
        instance: input.instance,
        params: {
          field: input.field,
          value: input.value,
          displayValue: input.displayValue || input['display-value'],
          url: input.url,
          tabId,
          focus: input.focus === true,
        },
      };
    },
  },

  // 12. Run UI Action
  {
    name: 'snu_run_ui_action',
    agentCommand: 'run_ui_action',
    description: 'Trigger a UI action on the form already open in the connected browser tab (e.g. "save", "submit", "sysverb_update"). This drives the live UI and is for exercising real form behaviour (client scripts, UI policies, business rules). It is NOT the way to create or update records as data: use snu_create_record and snu_update_record, which write through the REST API and are far more reliable.',
    cliCommand: 'browser action',
    cliUsage: 'snu browser action <action> [--no-suppress-dialogs] [--focus] [--url <u>] [--tab <id>] [--instance <i>] [--json]',
    cliOptions: {
      'no-suppress-dialogs': { type: 'boolean', description: 'Do not auto-confirm browser dialogs' },
      focus: { type: 'boolean', description: 'Bring the browser tab to the front' },

      url: { type: 'string', description: 'Target tab URL pattern' },
      tab: { type: 'string', description: 'Browser tab ID' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        uiAction: { type: 'string', description: 'Action name or sysverb verb (e.g. save, sysverb_update)' },
        suppressDialogs: { type: 'boolean', default: true, description: 'Auto-confirm browser dialogs' },
        url: { type: 'string', description: 'Target tab URL pattern (optional)' },
        tabId: { type: 'integer', description: 'Specific browser tab ID (optional)' },
        focus: { type: 'boolean', default: false, description: 'Bring the browser tab to the front. By default the tab stays in the background so the user can keep working' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['uiAction'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      const tabId = input.tabId ?? (input.tab ? parseInt(input.tab, 10) : undefined);
      const suppress = input.suppressDialogs !== false && input['no-suppress-dialogs'] !== true;
      return {
        command: 'run_ui_action',
        instance: input.instance,
        params: {
          uiAction: input.uiAction || input.action,
          suppressDialogs: suppress,
          url: input.url,
          tabId,
          focus: input.focus === true,
        },
      };
    },
  },

  // 13. Navigate
  {
    name: 'snu_navigate',
    agentCommand: 'navigate',
    description: 'Navigate connected ServiceNow browser tab to a URL and wait for page load to finish.',
    cliCommand: 'browser nav',
    cliUsage: 'snu browser nav <url> [--new-tab] [--no-wait] [--focus] [--instance <i>] [--json]',
    cliOptions: {
      'new-tab': { type: 'boolean', short: 'n', description: 'Open in new tab' },
      focus: { type: 'boolean', description: 'Bring the browser tab to the front' },

      'no-wait': { type: 'boolean', description: 'Do not wait for page load' },
      'no-discard-unsaved': { type: 'boolean', description: 'Do not bypass unsaved changes warnings' },
      tab: { type: 'string', description: 'Browser tab ID' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'ServiceNow URL to navigate to' },
        tabId: { type: 'integer', description: 'Specific tab ID to navigate (optional)' },
        newTab: { type: 'boolean', default: false, description: 'Open in a new tab instead of active tab' },
        waitForLoad: { type: 'boolean', default: true, description: 'Wait for page load event before returning' },
        discardUnsaved: { type: 'boolean', default: true, description: 'Bypass unsaved changes warnings' },
        focus: { type: 'boolean', default: false, description: 'Bring the browser tab to the front. By default the tab stays in the background so the user can keep working' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      const tabId = input.tabId ?? (input.tab ? parseInt(input.tab, 10) : undefined);
      return {
        command: 'navigate',
        instance: input.instance,
        params: {
          url: input.url,
          tabId,
          newTab: input.newTab === true || input['new-tab'] === true,
          waitForLoad: input.waitForLoad !== false && input['no-wait'] !== true,
          discardUnsaved: input.discardUnsaved !== false && input['no-discard-unsaved'] !== true,
          focus: input.focus === true,
        },
      };
    },
  },

  // 14. Take Screenshot
  {
    name: 'snu_take_screenshot',
    agentCommand: 'take_screenshot',
    description:
      'Capture a screenshot of a ServiceNow page tab and save it under screenshots/ in the workspace. Uses the tab\'s one-time grant (the user clicks the SN Utils icon on that tab once, E_SCREENSHOT_PERMISSION until then). With the Browser Debugger permission on for snu (the user runs `snu permissions set browserDebugger on`) and the SN Utils Debug edition with Pro, it captures through the Chrome debugger with no click.',
    cliCommand: 'screenshot',
    cliUsage: 'snu screenshot [--url <u>] [--tab <id>] [--file <name>] [--exact] [--focus] [--instance <i>] [--json]',
    cliOptions: {
      focus: { type: 'boolean', description: 'Leave the captured tab in front instead of switching back' },
      url: { type: 'string', short: 'u', description: 'URL pattern of tab to capture' },
      tab: { type: 'string', short: 't', description: 'Tab ID to capture' },
      file: { type: 'string', short: 'f', description: 'Custom PNG filename' },
      exact: { type: 'boolean', description: 'Require exact URL match' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL pattern of the tab to capture' },
        tabId: { type: 'integer', description: 'Specific tab ID to capture' },
        fileName: { type: 'string', description: 'Optional custom filename (defaults to timestamped PNG)' },
        exactUrl: { type: 'boolean', default: false, description: 'Require exact URL match' },
        focus: { type: 'boolean', default: false, description: 'Leave the captured tab in front afterwards. By default the capture switches back to the tab the user had open' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      anyOf: [{ required: ['url'] }, { required: ['tabId'] }],
      additionalProperties: false,
    },
    mapInput: (input) => {
      const tabId = input.tabId ?? (input.tab ? parseInt(input.tab, 10) : undefined);
      return {
        command: 'take_screenshot',
        instance: input.instance,
        params: {
          url: input.url,
          tabId,
          fileName: input.fileName || input.file,
          exactUrl: input.exactUrl === true || input.exact === true,
          focus: input.focus === true,
        },
      };
    },
  },

  // 15. Create Record (plain data rows)
  {
    name: 'snu_create_record',
    agentCommand: 'create_record',
    description:
      'Create a record on any ServiceNow table by inserting it through the REST API (POST /api/now/table/<table>). This is the correct way to create ordinary data rows: incidents, tasks, users, groups, CMDB CIs, catalog items, anything whose display field is not "name". The inserted record is returned in the response, so no separate read-back is needed. Prefer this over driving the browser UI (navigate + set field + run UI action), which is slower and far more fragile. Covered by the same createArtifacts permission as the other create commands, which is on by default. For scriptable artifacts (Script Include, Business Rule, ...) use snu_create_artifact instead so the record is tracked locally.',
    cliCommand: 'record create',
    cliUsage: 'snu record create <table> [field=value ...] [--fields <json>] [--scope <scope>] [--instance <i>] [--json]',
    cliOptions: {
      fields: { type: 'string', short: 'f', description: 'JSON object of field values' },
      scope: { type: 'string', short: 's', description: 'Transaction scope (application name or sys_id) to run the insert in; needed for rows of a scoped app table' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table to insert into (e.g. incident, sc_task, sys_user)' },
        fields: {
          type: 'object',
          description: 'Field-value dictionary for the new record. Use raw values (sys_id for reference fields, choice value for choice fields), not display labels.',
        },
        scope: { type: 'string', description: 'Transaction scope (application name or sys_id) to run the insert in. Needed for rows of a scoped app table; this sets sysparm_transaction_scope and does not write a sys_scope field, which plain data rows do not have. Optional.' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['table', 'fields'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      const table = typeof input.table === 'string' ? input.table.trim() : '';
      if (!table || !/^[a-zA-Z0-9_]+$/.test(table)) {
        throw new Error('Missing or invalid parameter "table" (must be alphanumeric/underscore)');
      }
      let fields: Record<string, any> = {};
      if (input.fields) {
        fields = typeof input.fields === 'string' ? JSON.parse(input.fields) : input.fields;
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
        throw new Error('Missing required parameter "fields": provide at least one field value for the new record');
      }
      return {
        command: 'create_record',
        instance: input.instance,
        params: { table, fields, ...(input.scope ? { scope: input.scope } : {}) },
      };
    },
  },

  // 18. Auth status (session health)
  {
    name: 'snu_auth_status',
    agentCommand: 'auth_status',
    description:
      'Check whether ServiceNow still accepts the browser session for an instance, using a bounded read-only request. This is the only check that proves the session works: bridge and helper-tab state are local inferences and can all be healthy while every operation returns 401. Returns AUTH_OK, AUTH_EXPIRED, AUTH_MISSING, HELPER_DISCONNECTED, INSTANCE_NOT_FOUND or AUTH_UNKNOWN. A 403 is AUTH_OK — the session authenticated and an ACL refused the row, which is a different problem.',
    cliCommand: 'auth status',
    cliUsage: 'snu auth status [--instance <i>] [--json]',
    inputSchema: {
      type: 'object',
      properties: {
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: [],
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'auth_status',
      instance: input.instance,
      params: {},
    }),
  },

  // 16. REST Request (generic escape hatch)
  {
    name: 'snu_rest_request',
    agentCommand: 'rest_request',
    description:
      'Call any ServiceNow REST endpoint through the authenticated browser session. The escape hatch for what the typed tools do not cover (Attachment API, Aggregate API, Import Set API, scripted REST APIs). GET is always allowed; POST/PUT/PATCH need the restRequest gate and DELETE needs the deleteRecords gate. For a plain record insert prefer snu_create_record, which wraps this and returns a record-shaped result.',
    cliCommand: 'rest',
    cliUsage: "snu rest <endpoint> [--method <M>] [--body <json>] [--query <k=v,k=v>] [--instance <i>] [--json]",
    cliOptions: {
      method: { type: 'string', short: 'm', description: 'HTTP method (default: GET)' },
      body: { type: 'string', short: 'b', description: 'JSON request body for POST/PUT/PATCH' },
      query: { type: 'string', short: 'q', description: 'Query parameters as k=v,k=v' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: "Instance-relative path beginning with '/' (e.g. /api/now/table/incident)" },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET', description: 'HTTP method' },
        body: { type: 'object', description: 'JSON request body for POST/PUT/PATCH' },
        queryParams: { type: 'object', description: 'Query-string parameters as a flat object' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['endpoint'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
      if (!endpoint.startsWith('/')) {
        throw new Error("Missing/invalid 'endpoint': must be an instance-relative path beginning with '/' (e.g. /api/now/table/incident)");
      }
      const method = String(input.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        throw new Error('Invalid method. Must be one of: GET, POST, PUT, PATCH, DELETE');
      }
      let body = input.body;
      if (typeof body === 'string' && body.trim()) body = JSON.parse(body);
      let queryParams = input.queryParams;
      if (typeof queryParams === 'string' && queryParams.trim()) queryParams = parseQueryPairs(queryParams);
      return {
        command: 'rest_request',
        instance: input.instance,
        params: {
          endpoint,
          method,
          body: body && typeof body === 'object' ? body : undefined,
          queryParams: queryParams && typeof queryParams === 'object' ? queryParams : undefined,
        },
      };
    },
  },

  // 17. Switch Context (update set / application scope / domain)
  {
    name: 'snu_switch_context',
    agentCommand: 'switch_context',
    description:
      "Switch the browser session's current update set, application scope or domain by sys_id. Uses the same picker API as the ServiceNow header (no form driving), so use it before snu_create_artifact or snu_update_record to make sure changes are captured in the right update set and application. Find the sys_id first with snu_query_records on sys_update_set, sys_scope or domain. One open ServiceNow tab is reloaded afterwards unless reloadTab is false.",
    cliCommand: 'switch',
    cliUsage: 'snu switch <updateset|application|domain> <sys_id> [--no-reload] [--tab-url <pattern>] [--instance <i>] [--json]',
    cliOptions: {
      'no-reload': { type: 'boolean', description: 'Do not reload a ServiceNow tab after switching' },
      'tab-url': { type: 'string', description: 'URL pattern of the tab to reload (default: https://*.service-now.com/*)' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        switchType: { type: 'string', enum: ['updateset', 'application', 'domain'], description: 'What to switch: updateset, application (scope) or domain' },
        value: { type: 'string', description: 'sys_id of the target update set, application (sys_scope) or domain' },
        reloadTab: { type: 'boolean', default: true, description: 'Reload one open ServiceNow tab afterwards so the header reflects the change' },
        tabUrl: { type: 'string', description: 'URL pattern of the tab to reload (default: https://*.service-now.com/*)' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['switchType', 'value'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      let switchType = String(input.switchType || input.type || '').trim().toLowerCase();
      if (switchType === 'app' || switchType === 'scope') switchType = 'application';
      if (switchType === 'update_set' || switchType === 'update-set') switchType = 'updateset';
      if (!['updateset', 'application', 'domain'].includes(switchType)) {
        throw new Error('Invalid switchType. Must be one of: updateset, application, domain');
      }
      const value = String(input.value ?? input.sysId ?? input.sys_id ?? '').trim();
      if (!value) throw new Error('Missing required value: the sys_id of the update set, application or domain');
      return {
        command: 'switch_context',
        instance: input.instance,
        params: {
          switchType,
          value,
          reloadTab: input.reloadTab !== false && input['no-reload'] !== true,
          tabUrl: input.tabUrl || input['tab-url'] || undefined,
        },
      };
    },
  },
  // NOW SDK app deploy
  {
    name: 'snu_sdk_deploy',
    agentCommand: 'sdk_deploy',
    description:
      'Build, pack and install a ServiceNow SDK (NOW SDK / Fluent) app on the instance with the browser session, without a separate SDK login. The user confirms the install in the SN Utils helper tab, so the call waits for them (up to 15 minutes). Stops with E_INSTANCE_CHANGED when the app changed on the instance since the last deploy or pull: ask the user whether to pull first (snu_sdk_pull) or overwrite (force: true). E_CONFIRM_REQUIRED means that check could not run: retry, or ask the user before force: true, which deploys without it. Returns installed, partial (installed but some flows did not activate), the rollback link and the flow activation result. Uses the instance the app was last deployed to or pulled from when none is given. Requires SN Utils Pro or Trial and the createArtifacts permission.',
    cliCommand: 'sdk deploy',
    cliUsage: 'snu sdk deploy [projectPath] [--force] [--instance <i>] [--json]',
    cliOptions: {
      force: { type: 'boolean', short: 'f', description: 'Deploy even when the app changed on the instance since the last deploy or pull' },
    },
    timeoutMs: 16 * 60 * 1000,
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Folder of the NOW SDK project (the one with now.config.json), relative to the workspace root or absolute. Optional when the workspace holds one project.' },
        force: { type: 'boolean', default: false, description: 'Overwrite changes made on the instance since the last deploy or pull. Only after the user agreed.' },
        instance: { type: 'string', description: 'Target instance name/folder (optional; defaults to the app\'s linked instance)' },
      },
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'sdk_deploy',
      instance: input.instance || linkedSdkInstance(sdkProjectPath(input)),
      params: { projectPath: sdkProjectPath(input), force: input.force === true },
    }),
  },

  // NOW SDK app pull
  {
    name: 'snu_sdk_pull',
    agentCommand: 'sdk_pull',
    description:
      'Pull changes made on the instance into a ServiceNow SDK (NOW SDK / Fluent) project, with the browser session and the project\'s own SDK (no separate SDK login). Applies straight away when the affected files have no uncommitted git changes, so the user can review with git diff and undo with git checkout. E_CONFIRM_REQUIRED means the project is not in git or an affected file has uncommitted edits: ask the user before passing force: true. dryRun only lists the changes. Uses the instance the app was last deployed to or pulled from when none is given. Requires SN Utils Pro or Trial.',
    cliCommand: 'sdk pull',
    cliUsage: 'snu sdk pull [projectPath] [--dry-run] [--force] [--instance <i>] [--json]',
    cliOptions: {
      'dry-run': { type: 'boolean', short: 'n', description: 'Only list what would change' },
      force: { type: 'boolean', short: 'f', description: 'Apply even when the project is not in git or affected files have uncommitted edits' },
    },
    timeoutMs: 5 * 60 * 1000,
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Folder of the NOW SDK project (the one with now.config.json), relative to the workspace root or absolute. Optional when the workspace holds one project.' },
        dryRun: { type: 'boolean', default: false, description: 'Only list what would change' },
        force: { type: 'boolean', default: false, description: 'Apply even without git protection. Only after the user agreed.' },
        instance: { type: 'string', description: 'Target instance name/folder (optional; defaults to the app\'s linked instance)' },
      },
      additionalProperties: false,
    },
    mapInput: (input) => ({
      command: 'sdk_pull',
      instance: input.instance || linkedSdkInstance(sdkProjectPath(input)),
      params: { projectPath: sdkProjectPath(input), force: input.force === true, dryRun: input.dryRun === true || input['dry-run'] === true },
    }),
  },
  {
    name: 'snu_negotiate', agentCommand: 'negotiate', cliCommand: 'negotiate',
    description: 'Report bridge and helper versions, connection state and the authoritative supported command list. Works without a connected helper.',
    cliUsage: 'snu negotiate [--json]',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    mapInput: () => ({ command: 'negotiate', params: {} }),
  },
  {
    name: 'snu_update_record_batch', agentCommand: 'update_record_batch', cliCommand: 'record update-batch',
    description: 'Update several fields on one record in one request with persistence verification. Requires updateRecords permission. This does not update multiple records.',
    cliUsage: 'snu record update-batch <table> <sys_id> (--fields <json> | --file <json-file> | stdin) [--instance <i>] [--json]',
    cliOptions: {
      fields: { type: 'string', short: 'f', description: 'JSON field-value object' },
      file: { type: 'string', description: 'Read field values from a JSON file' },
    },
    inputSchema: {
      type: 'object', properties: {
        table: { type: 'string', description: 'ServiceNow table name' },
        sys_id: { type: 'string', description: '32-character record sys_id' },
        fields: { type: 'object', description: 'Field values to update' },
        fieldsFile: { type: 'string', description: 'JSON file inside the local CLI/MCP workspace; conflicts with fields' },
        instance: { type: 'string', description: 'Target instance' },
      }, required: ['table', 'sys_id'], anyOf: [{ required: ['fields'] }, { required: ['fieldsFile'] }], additionalProperties: false,
    },
    mapInput: input => {
      const fields = resolveFieldValues(input);
      if (!Object.keys(fields).length) throw Object.assign(new Error('Fields object cannot be empty'), { code: 'E_INVALID_PARAMS' });
      return { command: 'update_record_batch', instance: input.instance,
        params: { table: input.table, sys_id: input.sys_id, fields, await: true } };
    },
  },
  {
    name: 'snu_upload_attachment', agentCommand: 'upload_attachment', cliCommand: 'attachment upload',
    description: 'Attach a local workspace file or base64 data to one ServiceNow record. Requires createArtifacts permission. Relative filePath is resolved under the instance folder on the bridge; absolute paths must stay inside its workspace.',
    cliUsage: 'snu attachment upload <table> <sys_id> --file <path> [--name <file-name>] [--content-type <mime>] [--instance <i>] [--json]',
    cliOptions: {
      file: { type: 'string', short: 'f', description: 'Workspace file to attach' },
      name: { type: 'string', description: 'Attachment name (default: file basename)' },
      'content-type': { type: 'string', description: 'MIME type (default: inferred from file)' },
    },
    inputSchema: {
      type: 'object', properties: {
        table: { type: 'string', description: 'Table containing the target record' },
        sys_id: { type: 'string', description: '32-character record sys_id' },
        filePath: { type: 'string', description: 'Path to a file inside the bridge workspace' },
        imageData: { type: 'string', description: 'Base64 attachment data, alternative to filePath' },
        fileName: { type: 'string', description: 'Required for imageData; defaults to file basename for filePath' },
        contentType: { type: 'string', description: 'Attachment MIME type' },
        instance: { type: 'string', description: 'Target instance' },
      }, required: ['table', 'sys_id'], anyOf: [{ required: ['filePath'] }, { required: ['imageData', 'fileName'] }], additionalProperties: false,
    },
    mapInput: input => ({ command: 'upload_attachment', instance: input.instance, params: {
      table: input.table, sys_id: input.sys_id, filePath: input.filePath,
      imageData: input.imageData, fileName: input.fileName, contentType: input.contentType,
    } }),
  },
  {
    name: 'snu_get_review_result', agentCommand: 'get_review_result', cliCommand: 'review result',
    description: 'Collect a reviewed command\'s pending, running or completed outcome. Poll the same reviewId instead of repeating a write; completed results are retained for 10 minutes.',
    cliUsage: 'snu review result <reviewId> [--wait <seconds>] [--json]',
    cliOptions: { wait: { type: 'string', description: 'Long-poll time, 0 to 55 seconds (default: 30)' } },
    inputSchema: { type: 'object', properties: {
      reviewId: { type: 'string', description: 'ID returned with E_REVIEW_PENDING' },
      waitSeconds: { type: 'number', minimum: 0, maximum: 55, description: 'Long-poll time in seconds (default: 30)' },
    }, required: ['reviewId'], additionalProperties: false },
    mapInput: input => {
      const waitSeconds = input.waitSeconds ?? (input.wait === undefined ? undefined : Number(input.wait));
      if (waitSeconds !== undefined && (typeof waitSeconds !== 'number' || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 55)) {
        throw Object.assign(new Error('Wait must be a number from 0 to 55 seconds'), { code: 'E_INVALID_PARAMS' });
      }
      return { command: 'get_review_result', params: { reviewId: input.reviewId, waitSeconds } };
    },
  },
];

const toolMap = new Map<string, ToolDefinition>();
const cliMap = new Map<string, ToolDefinition>();

for (const t of TOOLS) {
  toolMap.set(t.name, t);
  cliMap.set(t.cliCommand, t);
}

export function getToolByName(name: string): ToolDefinition | undefined {
  return toolMap.get(name);
}

export function getToolByCliCommand(cliCmd: string): ToolDefinition | undefined {
  return cliMap.get(cliCmd);
}
