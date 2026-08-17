import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TOOLS, getToolByName } from '../registry.js';
import { ScriptSyncClient, discoverBridge } from '../client.js';
import { StandaloneBridge } from '../server/standalone.js';

export async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer({
    name: 'sn-utils',
    version: '0.1.0',
  });

  const client = new ScriptSyncClient();

  // Helper to execute a tool and wrap errors into isError tool responses
  async function executeTool(name: string, args: Record<string, any>) {
    const tool = getToolByName(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      };
    }

    try {
      if (name === 'snu_get_context') {
        const result = await client.getContext(args.instance);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      const mapped = tool.mapInput(args);
      const resp = await client.execute(mapped);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(resp.result, null, 2) }],
      };
    } catch (err: any) {
      console.error(`[snu-mcp] Error executing ${name}:`, err?.message || err);
      const userFeedback = err.details?.userFeedback ? ` - User Feedback: "${err.details.userFeedback}"` : '';
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Error (${err?.code || 'E_COMMAND_FAILED'}): ${err?.message || err}${userFeedback}`,
          },
        ],
      };
    }
  }

  // 1. Code Search
  server.tool(
    'snu_code_search',
    'Fast SN Utils GraphQL field-index code search across Script Includes, Business Rules, Client Scripts, UI Actions, and Flow Actions. Requires SN Utils Pro.',
    {
      term: z.string().min(2).describe('Search keyword or phrase (min 2 chars)'),
      tables: z.string().optional().describe('Optional comma-separated table names to filter search'),
      limit: z.number().int().min(1).max(500).default(50).optional().describe('Max hits to return'),
      activeOnly: z.boolean().default(false).optional().describe('Only search active records'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_code_search', args)
  );

  // 2. Schema
  server.tool(
    'snu_get_schema',
    'Fetch column dictionary metadata for a table (types, labels, references, choice lists, mandatory/read-only flags).',
    {
      table: z.string().describe('ServiceNow table name (e.g. incident, sys_user)'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_get_schema', args)
  );

  // 3. Context
  server.tool(
    'snu_get_context',
    'Inspect active ServiceNow connection status, helper tab state, license tier, available instances, and permission gates.',
    {
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_get_context', args)
  );

  // 4. Query Records
  server.tool(
    'snu_query_records',
    'Query records from any ServiceNow table with an encoded query string, projection fields, and limit.',
    {
      table: z.string().describe('Table name to query'),
      query: z.string().optional().describe('ServiceNow encoded query string (e.g. active=true^priority=1)'),
      fields: z.string().optional().describe('Comma-separated field list to project'),
      limit: z.number().int().min(1).max(500).default(10).optional().describe('Max records to return'),
      orderBy: z.string().optional().describe('Order by field expression (e.g. sys_created_on or ORDERBYDESCsys_created_on)'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_query_records', args)
  );

  // 5. Get Record
  server.tool(
    'snu_get_record',
    'Fetch a single record by sys_id with optional field projection.',
    {
      table: z.string().describe('Table name'),
      sys_id: z.string().describe('32-character record sys_id'),
      fields: z.string().optional().describe('Comma-separated field list (optional)'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_get_record', args)
  );

  // 6. Create Artifact
  server.tool(
    'snu_create_artifact',
    'Create a new scriptable artifact (Script Include, Business Rule, etc.) in ServiceNow and track it locally. Requires fields.name and createArtifacts.enabled gate. Note: If review mode is enabled in VS Code settings, the write is staged for manual approval rather than applied immediately.',
    {
      table: z.string().describe('Target ServiceNow artifact table (e.g. sys_script_include)'),
      name: z.string().describe('Artifact name (will be mapped into fields.name)'),
      fields: z.record(z.any()).optional().describe('Additional field-value dictionary (e.g. script, description)'),
      scope: z.string().optional().describe('Application scope (optional)'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_create_artifact', args)
  );

  // 7. Update Record
  server.tool(
    'snu_update_record',
    'Update a field on an existing ServiceNow record with synchronous persistence verification. Note: If review mode is enabled in VS Code settings, the write is staged for manual approval rather than applied immediately.',
    {
      table: z.string().describe('Table name'),
      sys_id: z.string().describe('Record sys_id'),
      field: z.string().describe('Field name to update (e.g. script, short_description)'),
      value: z.string().describe('New field content'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_update_record', args)
  );

  // 8. Delete Record
  server.tool(
    'snu_delete_record',
    'Delete a single record from ServiceNow by sys_id. Destructive: disabled by default (deleteRecords.enabled) and requires confirm: true or dryRun: true.',
    {
      table: z.string().describe('Table name'),
      sys_id: z.string().describe('Record sys_id'),
      confirm: z.boolean().describe('Must be set to true to execute deletion'),
      dryRun: z.boolean().optional().describe('When true, returns the record that would be deleted without deleting it'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_delete_record', args)
  );

  // 9. Run Background Script
  server.tool(
    'snu_run_background_script',
    'Execute server-side JavaScript on the instance via Background Scripts and return captured output. Gated by backgroundScripts.enabled.',
    {
      script: z.string().describe('JavaScript code to execute on the instance'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_run_background_script', args)
  );

  // 10. Get Form State
  server.tool(
    'snu_get_form_state',
    'Read live form table, sys_id, new-record state, and field values from the active connected ServiceNow browser tab.',
    {
      fields: z.array(z.string()).optional().describe('Optional list of specific field names to read'),
      url: z.string().optional().describe('Target tab URL pattern (optional)'),
      tabId: z.number().int().optional().describe('Specific browser tab ID (optional)'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_get_form_state', args)
  );

  // 11. Set Form Field
  server.tool(
    'snu_set_form_field',
    'Set a field value on the active ServiceNow form via g_form.setValue (triggers client scripts and UI policies).',
    {
      field: z.string().describe('Field name to set'),
      value: z.string().describe('New value to set'),
      displayValue: z.string().optional().describe('Optional display value for reference fields'),
      url: z.string().optional().describe('Target tab URL pattern (optional)'),
      tabId: z.number().int().optional().describe('Specific browser tab ID (optional)'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_set_form_field', args)
  );

  // 12. Run UI Action
  server.tool(
    'snu_run_ui_action',
    'Trigger a UI action on the active form (e.g. save, submit, sysverb_update).',
    {
      uiAction: z.string().describe('Action name or sysverb verb (e.g. save, sysverb_update)'),
      suppressDialogs: z.boolean().default(true).optional().describe('Auto-confirm browser dialogs'),
      url: z.string().optional().describe('Target tab URL pattern (optional)'),
      tabId: z.number().int().optional().describe('Specific browser tab ID (optional)'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_run_ui_action', args)
  );

  // 13. Navigate
  server.tool(
    'snu_navigate',
    'Navigate connected ServiceNow browser tab to a URL and wait for page load to finish.',
    {
      url: z.string().describe('ServiceNow URL to navigate to'),
      tabId: z.number().int().optional().describe('Specific tab ID to navigate (optional)'),
      newTab: z.boolean().default(false).optional().describe('Open in a new tab instead of active tab'),
      waitForLoad: z.boolean().default(true).optional().describe('Wait for page load event before returning'),
      discardUnsaved: z.boolean().default(true).optional().describe('Bypass unsaved changes warnings'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_navigate', args)
  );

  // 14. Take Screenshot
  server.tool(
    'snu_take_screenshot',
    'Capture a screenshot of a ServiceNow page tab (auto-routes between standard capture and debugger if available). Saves under workspace screenshots/.',
    {
      url: z.string().optional().describe('URL pattern of the tab to capture'),
      tabId: z.number().int().optional().describe('Specific tab ID to capture'),
      fileName: z.string().optional().describe('Optional custom filename (defaults to timestamped PNG)'),
      exactUrl: z.boolean().default(false).optional().describe('Require exact URL match'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => {
      if (!args.url && args.tabId === undefined) {
        args.url = 'https://*.service-now.com/*';
      }
      return executeTool('snu_take_screenshot', args);
    }
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  // Ensure all logging goes strictly to stderr
  console.error('[snu-mcp] Starting SN Utils MCP Server on stdio...');

  // Auto-start in-process standalone bridge if no bridge is currently reachable
  try {
    await discoverBridge();
  } catch (err: any) {
    if (
      err?.code === 'E_BRIDGE_NOT_FOUND' ||
      err?.code === 'E_BRIDGE_UNREACHABLE' ||
      err?.code === 'E_STALE_PORT_FILE'
    ) {
      console.error('[snu-mcp] No active VS Code bridge found. Starting in-process standalone bridge on WS 1978 & HTTP 1977...');
      const standalone = new StandaloneBridge();
      await standalone.start();
      console.error('[snu-mcp] In-process standalone bridge active.');
    }
  }

  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[snu-mcp] Connected on stdio. 14 tools registered.');
}
