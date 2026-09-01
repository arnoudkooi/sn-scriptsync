import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TOOLS, getToolByName } from '../registry.js';
import { ScriptSyncClient, discoverBridge, checkHealth } from '../client.js';
import { StandaloneBridge } from '../server/standalone.js';
import { reclaimPort } from '../cli/portReclaim.js';
import { resolveBridgeAttachment } from '../cli/attachment.js';

// Surfaced verbatim by MCP clients. This is the only guidance an agent that
// reaches the bridge over MCP ever sees: it has no access to the ScriptSync
// agent rules unless it happens to be working inside a sync workspace. Keep it
// short and keep it about routing (which tool for which job), not features.
const SERVER_INSTRUCTIONS = [
  'These tools drive a live ServiceNow instance through the user\'s authenticated browser session.',
  '',
  'Start of session: call snu_get_context once. It reports the connected instance, helper tab state,',
  'license tier and which permission gates are open. Every ServiceNow-touching tool needs the SN Utils',
  'helper tab open in the browser; without it you get E_BROWSER_DISCONNECTED, which is a setup step for',
  'the user, not a tool failure.',
  '',
  'Choosing a write tool:',
  '- Plain data row (incident, task, sys_user, sys_user_group, cmdb_ci, sc_request, ...) -> snu_create_record.',
  '- Scriptable artifact (Script Include, Business Rule, Client Script, UI Action, widget) -> snu_create_artifact,',
  '  which also tracks the record in the local workspace. Pass scope when the user has said which',
  '  application they are working in — you cannot see their application picker. Omitting it creates the',
  '  record in whatever application their session is in; the result reports effectiveScope, so check it.',
  '- Changing a field on an existing record -> snu_update_record.',
  '- Anything the typed tools do not cover (Attachment API, Aggregate API, scripted REST) -> snu_rest_request.',
  '',
  'Do not create or edit records by driving the browser UI. snu_navigate, snu_set_form_field and',
  'snu_run_ui_action exist to exercise real form behaviour (client scripts, UI policies, mandatory-field',
  'handling) and to show the user something on screen. Using them as a way to write data is slow, silently',
  'lossy, and leaves half-filled forms behind when a step fails.',
  '',
  'E_DISABLED means a permission gate is off. It is a deliberate user setting, not an obstacle to work',
  'around: report which gate and how to enable it, then stop. Never substitute a different mechanism',
  '(browser UI, background script) to achieve a write the user has gated off.',
  '',
  'After any write, the returned record is the confirmation. Read it back with snu_get_record only when',
  'you need fields the write did not return.',
].join('\n');

export async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer(
    {
      name: 'sn-utils',
      version: '0.1.0',
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

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
      // Not a tool failure: the browser helper tab simply is not open. Return
      // a normal result with instructions so the agent guides the user
      // instead of surfacing (or retry-looping on) a raw error.
      if (err?.code === 'E_BROWSER_DISCONNECTED') {
        const steps: string[] = Array.isArray(err.details?.guidance) && err.details.guidance.length
          ? err.details.guidance
          : ['Open the ServiceNow instance in the browser, type /token in the SN Utils slash palette to open the helper tab, keep it open, then retry.'];
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'ServiceNow is not connected yet: the SN Utils helper tab is not open in the browser. ' +
                'This is a setup step only the user can do. Ask the user to:\n' +
                steps.map((s, i) => `${i + 1}. ${s}`).join('\n') +
                '\nThen run this tool again. Readiness can be checked with snu_get_context.',
            },
          ],
        };
      }
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
    'Create a new scriptable artifact (Script Include, Business Rule, etc.) in ServiceNow and track it locally. Requires fields.name and the createArtifacts.enabled gate. Pass scope to pin the application (its name, e.g. x_acme_app, or "global"); omit it and the record is created in whichever application the user\'s ServiceNow session is currently in. Prefer passing it when the user has told you which application they are working in — you cannot see their application picker. The result reports effectiveScope and warns when no scope was given: check it, because an artifact filed into the wrong application is invisible until commit time and then has to be deleted and recreated. Note: If review mode is enabled in VS Code settings, the write is staged for manual approval rather than applied immediately.',
    {
      table: z.string().describe('Target ServiceNow artifact table (e.g. sys_script_include)'),
      name: z.string().describe('Artifact name (will be mapped into fields.name)'),
      fields: z.record(z.any()).optional().describe('Additional field-value dictionary (e.g. script, description)'),
      scope: z
        .string()
        .optional()
        .describe('Application scope name (e.g. x_acme_app) or sys_id, or "global". Omit to use the session\'s current application; the result reports where it landed.'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_create_artifact', args)
  );

  // 7. Update Record
  server.tool(
    'snu_update_record',
    'Update a field on an existing ServiceNow record with synchronous persistence verification. Covered by the updateRecords permission, which is on by default and follows createArtifacts where it is not set on its own. Note: If review mode is enabled in VS Code settings, the write is staged for manual approval rather than applied immediately.',
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

  // 15. Create Record
  server.tool(
    'snu_create_record',
    'Create a record on any ServiceNow table by inserting it through the REST API (POST /api/now/table/<table>). This is the correct way to create ordinary data rows: incidents, tasks, users, groups, CMDB CIs, catalog items, anything whose display field is not "name". The inserted record is returned in the response, so no separate read-back is needed. Prefer this over driving the browser UI (navigate + set field + run UI action), which is slower and far more fragile. Covered by the same createArtifacts permission as the other create commands, which is on by default. For scriptable artifacts (Script Include, Business Rule, ...) use snu_create_artifact instead so the record is tracked locally.',
    {
      table: z.string().describe('Table to insert into (e.g. incident, sc_task, sys_user)'),
      fields: z
        .record(z.any())
        .describe('Field-value dictionary for the new record. Use raw values (sys_id for reference fields, choice value for choice fields), not display labels.'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_create_record', args)
  );

  // 16. REST Request
  server.tool(
    'snu_rest_request',
    'Call any ServiceNow REST endpoint through the authenticated browser session. The escape hatch for what the typed tools do not cover (Attachment API, Aggregate API, Import Set API, scripted REST APIs). GET is always allowed; POST/PUT/PATCH need the restRequest gate and DELETE needs the deleteRecords gate. For a plain record insert prefer snu_create_record, which wraps this and returns a record-shaped result.',
    {
      endpoint: z.string().describe("Instance-relative path beginning with '/' (e.g. /api/now/table/incident)"),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET').optional().describe('HTTP method'),
      body: z.record(z.any()).optional().describe('JSON request body for POST/PUT/PATCH'),
      queryParams: z.record(z.string()).optional().describe('Query-string parameters as a flat object'),
      instance: z.string().optional().describe('Target instance name/folder (optional)'),
    },
    async (args) => executeTool('snu_rest_request', args)
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  // Ensure all logging goes strictly to stderr
  console.error('[snu-mcp] Starting SN Utils MCP Server on stdio...');

  // Obtain a bridge WITHOUT displacing one that is already serving.
  //
  // This used to reclaim port 1978 and start its own bridge whenever discovery
  // failed. Discovery fails when the descriptor is missing or stale, which says
  // nothing about whether a bridge is running — so a healthy standalone bridge
  // belonging to another MCP client was stopped and replaced. A running bridge
  // is proven by its health endpoint, not by a file.
  const attachment = await resolveBridgeAttachment({
    discover: async () => {
      const d = await discoverBridge();
      return { port: d.port, pid: d.pid };
    },
    probeHealth: async (port: number) => {
      try {
        return await checkHealth(port);
      } catch {
        return undefined;
      }
    },
  });

  console.error(`[snu-mcp] ${attachment.reason}`);

  if (attachment.mode === 'create-standalone') {
    try {
      // Only now, with nothing answering, may a held port be reclaimed: it is
      // bound by something that is not serving. Editor hosts and foreign
      // processes are still refused by reclaimPort itself.
      const reclaimed = await reclaimPort(1978, {});
      if (reclaimed.status === 'reclaimed' && reclaimed.listener) {
        console.error(`[snu-mcp] Stopped a non-responding bridge (PID ${reclaimed.listener.pid}) to free port 1978.`);
      }
      const standalone = new StandaloneBridge();
      const { httpPort, wsPort } = await standalone.start();
      console.error(`[snu-mcp] In-process standalone bridge active on HTTP ${httpPort} / WS ${wsPort}.`);
    } catch (startErr: any) {
      console.error(
        `[snu-mcp] Could not start in-process bridge: ${startErr?.message || startErr}. ` +
          'Continuing as MCP server only; ServiceNow commands will fail until a bridge is available.'
      );
    }
  }

  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[snu-mcp] Connected on stdio. ${TOOLS.length} tools registered.`);
}
