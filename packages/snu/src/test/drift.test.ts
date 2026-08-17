import test from 'node:test';
import assert from 'node:assert';
import { TOOLS } from '../registry.js';

// The canonical list of 25 Agent API commands supported by the ScriptSync bridge (v7)
const BRIDGE_COMMANDS = new Set([
  'check_connection',
  'get_sync_status',
  'get_last_error',
  'clear_last_error',
  'sync_now',
  'get_instance_info',
  'list_instances',
  'get_capabilities',
  'update_record',
  'update_record_batch',
  'create_artifact',
  'get_record',
  'delete_record',
  'get_table_metadata',
  'check_name_exists_remote',
  'query_records',
  'get_parent_options',
  'code_search',
  'get_workspace_files',
  'get_file_content',
  'save_file_content',
  'open_in_browser',
  'get_served_url',
  'refresh_preview',
  'take_screenshot',
  'navigate_and_screenshot',
  'run_slash_command',
  'activate_tab',
  'switch_context',
  'upload_attachment',
  'set_field',
  'get_form_state',
  'run_ui_action',
  'click_element',
  'navigate',
  'create_application',
  'add_column',
  'create_table',
  'rest_request',
  'run_background_script',
  'delete_application',
]);

test('Drift: every registry tool targets a valid bridge command', () => {
  for (const tool of TOOLS) {
    if (tool.name === 'snu_get_context') {
      // Composite client helper
      continue;
    }
    assert.ok(
      BRIDGE_COMMANDS.has(tool.agentCommand),
      `Tool '${tool.name}' targets unknown bridge command '${tool.agentCommand}'`
    );
  }
});
