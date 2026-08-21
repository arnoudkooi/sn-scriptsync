import { ToolDefinition, MappedCommand } from './types.js';

function formatOrderBy(orderBy?: string): string | undefined {
  if (!orderBy) return undefined;
  const trimmed = orderBy.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('ORDERBY')) return trimmed;
  return `ORDERBY${trimmed}`;
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
      'Create a new scriptable artifact (Script Include, Business Rule, etc.) in ServiceNow and track it locally. Requires fields.name and createArtifacts.enabled gate. Note: If review mode is enabled in VS Code settings, the write is staged for manual approval rather than applied immediately.',
    cliCommand: 'artifact create',
    cliUsage: 'snu artifact create <table> <name> [--fields <json>] [--scope <scope>] [--instance <i>] [--json]',
    cliOptions: {
      fields: { type: 'string', short: 'f', description: 'JSON payload dictionary' },
      scope: { type: 'string', short: 's', description: 'Application scope' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Target ServiceNow artifact table (e.g. sys_script_include)' },
        name: { type: 'string', description: 'Artifact name (will be mapped into fields.name)' },
        fields: { type: 'object', description: 'Additional field-value dictionary' },
        scope: { type: 'string', description: 'Application scope (optional)' },
        instance: { type: 'string', description: 'Target instance name/folder (optional)' },
      },
      required: ['table', 'name'],
      additionalProperties: false,
    },
    mapInput: (input) => {
      let fields: Record<string, any> = {};
      if (input.fields) {
        fields = typeof input.fields === 'string' ? JSON.parse(input.fields) : input.fields;
      }
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
      'Update a field on an existing ServiceNow record with synchronous persistence verification. Note: If review mode is enabled in VS Code settings, the write is staged for manual approval rather than applied immediately.',
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
    cliUsage: 'snu browser set <field> <value> [--display-value <v>] [--url <u>] [--tab <id>] [--instance <i>] [--json]',
    cliOptions: {
      'display-value': { type: 'string', short: 'd', description: 'Display value for reference fields' },
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
        },
      };
    },
  },

  // 12. Run UI Action
  {
    name: 'snu_run_ui_action',
    agentCommand: 'run_ui_action',
    description: 'Trigger a UI action on the active form (e.g. "save", "submit", "sysverb_update").',
    cliCommand: 'browser action',
    cliUsage: 'snu browser action <action> [--no-suppress-dialogs] [--url <u>] [--tab <id>] [--instance <i>] [--json]',
    cliOptions: {
      'no-suppress-dialogs': { type: 'boolean', description: 'Do not auto-confirm browser dialogs' },
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
    cliUsage: 'snu browser nav <url> [--new-tab] [--no-wait] [--instance <i>] [--json]',
    cliOptions: {
      'new-tab': { type: 'boolean', short: 'n', description: 'Open in new tab' },
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
        },
      };
    },
  },

  // 14. Take Screenshot
  {
    name: 'snu_take_screenshot',
    agentCommand: 'take_screenshot',
    description:
      'Capture a screenshot of a ServiceNow page tab (auto-routes between standard capture and debugger if available). Saves under workspace screenshots/.',
    cliCommand: 'screenshot',
    cliUsage: 'snu screenshot [--url <u>] [--tab <id>] [--file <name>] [--exact] [--instance <i>] [--json]',
    cliOptions: {
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
        },
      };
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
