// The standalone HTTP and negotiation surfaces advertise the same support set.
// yield is handled by the HTTP transport; the other commands reach the dispatcher.
export const STANDALONE_COMMANDS = [
  'check_connection', 'auth_status', 'get_instance_info', 'list_instances',
  'get_capabilities', 'negotiate', 'get_review_result', 'query_records',
  'get_record', 'update_record', 'update_record_batch', 'create_artifact',
  'create_record', 'delete_record', 'get_table_metadata', 'pull_records',
  'pull_artifacts', 'pull_scope', 'code_search', 'run_background_script',
  'rest_request', 'get_form_state', 'set_field', 'run_ui_action', 'navigate',
  'take_screenshot', 'switch_context', 'upload_attachment', 'sdk_deploy',
  'sdk_pull', 'yield',
] as const;
