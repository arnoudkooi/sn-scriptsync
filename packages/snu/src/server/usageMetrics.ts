// Mirrored in both hosts. Only allowlisted categories and integers leave the process.
const COMMANDS = new Set([

        'query_records', 'get_record', 'update_record', 'update_record_batch',
        'create_artifact', 'create_record', 'delete_record', 'get_table_metadata',
        'pull_records', 'pull_artifacts', 'pull_scope', 'code_search',
        'run_background_script', 'rest_request', 'get_form_state', 'set_field',
        'run_ui_action', 'navigate', 'take_screenshot', 'switch_context',
        'upload_attachment', 'download_attachment', 'delete_attachment',
        'sdk_deploy', 'sdk_pull', 'create_records', 'update_records',
        'analyze_artifact_type', 'get_context', 'click_element', 'activate_tab',
        'run_slash_command', 'refresh_preview', 'create_application', 'delete_application',
        'list_applications', 'get_application', 'start_network_capture', 'stop_network_capture',
        'start_console_capture', 'stop_console_capture', 'get_network_log', 'get_console_log',
        'set_dialog_handler', 'clear_dialog_handler', 'debugger_detach',
        'capture_full_page', 'open_in_browser', 'get_served_url', 'navigate_and_screenshot',
        'list_tables', 'list_artifacts', 'check_name_exists', 'get_file_structure',
        'validate_path', 'add_column', 'create_table', 'get_parent_options', 'check_name_exists_remote',
    ]);
export interface UsageResponse {
    status: string;
    code?: string;
    result?: any;
    details?: any;
}
export type FinishUsage = (response: UsageResponse) => void;

/** Capture session ownership at start; never attribute old work to a replacement helper. */
export function beginUsage(
    command: string, dryRun: boolean, host: 'vscode' | 'standalone',
    getSession: () => string | undefined, send: (event: object) => void,
): FinishUsage {
    let session: string | undefined;
    try { session = getSession(); } catch { /* disconnected / older host */ }
    let finished = false;
    return response => {
        try {
            if (finished || !session || !COMMANDS.has(command) || getSession() !== session) return;
            if (response.code === 'E_REVIEW_PENDING' || response.result?.staged === true
                || response.result?.running === true || response.result?.duplicate === true || response.details?.duplicate === true) return;
            finished = true;
            const code = response.code || '';
            const outcome = response.status === 'success'
                ? (dryRun || response.result?.dryRun === true ? 'dry_run' : 'success')
                : ['E_USER_REJECTED', 'E_CANCELLED', 'E_REVIEW_EXPIRED'].includes(code) ? 'cancelled'
                : ['E_DISABLED', 'E_PAUSED', 'E_SECURITY', 'E_PRO_REQUIRED', 'E_LICENSE_REQUIRED'].includes(code) ? 'blocked'
                : 'error';
            const rows: Record<string, number> = {};
            const report = response.status === 'success' ? response.result : response.details;
            // A bulk reply already contains bounded numerical totals. Never send rows or IDs.
            if (outcome !== 'dry_run' && ['create_records', 'update_records'].includes(command)) {
                for (const [field, key] of Object.entries({ succeeded: 'succeeded', failed: 'failed', notAttempted: 'not_attempted', unknown: 'unknown' })) {
                    const value = report?.counts?.[field];
                    if (Number.isInteger(value) && value > 0 && value <= 10000) rows[key] = value;
                }
            }
            if (outcome !== 'dry_run' && command === 'delete_record' && Array.isArray(report?.results)) {
                rows.succeeded = report.results.filter((row: any) => row?.deleted === true).length;
                rows.failed = report.results.filter((row: any) => row?.deleted === false).length;
            }
            send({ action: 'agentUsage', usageSession: session, host, command, outcome, rows });
        } catch { /* Analytics must never change a command's result. */ }
    };
}
