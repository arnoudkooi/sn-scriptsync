import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { TOOLS } from '../registry.js';
import { VERSION } from '../cli/index.js';

// The canonical list of Agent API commands supported by the ScriptSync bridge (v7)
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
  'create_record',
  'get_record',
  'delete_record',
  'get_table_metadata',
  'check_name_exists_remote',
  'pull_records',
  'pull_artifacts',
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

test('Drift: CLI version matches package metadata', () => {
  const packageMetadata = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
  ) as { version: string };

  assert.strictEqual(VERSION, packageMetadata.version);
});

test('Drift: package publishes the SN Utils Service Terms notice', () => {
  const packageRoot = path.resolve(__dirname, '../..');
  const packageMetadata = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  ) as { license?: string; files?: string[] };

  assert.strictEqual(packageMetadata.license, 'SEE LICENSE IN LICENSE.md');
  assert.ok(packageMetadata.files?.includes('LICENSE.md'));
  const licenseNotice = fs.readFileSync(path.join(packageRoot, 'LICENSE.md'), 'utf8');
  assert.match(licenseNotice, /https:\/\/snutils\.com\/legal\/service-terms/);
  assert.doesNotMatch(licenseNotice, /\bMIT\b|\bUNLICENSED\b/i);
});
