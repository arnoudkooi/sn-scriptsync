/**
 * Terminal formatters and JSON output renderer for @snutils/snu CLI
 */

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function formatTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return `${ANSI.gray}(no records)${ANSI.reset}`;

  const colWidths = headers.map((h, i) => {
    let max = stripAnsi(h).length;
    for (const row of rows) {
      const cell = row[i] ? stripAnsi(row[i]) : '';
      if (cell.length > max) max = cell.length;
    }
    return Math.min(max, 60); // Cap column width at 60 chars
  });

  const headerLine = headers
    .map((h, i) => `${ANSI.bold}${h.padEnd(colWidths[i])}${ANSI.reset}`)
    .join('  ');
  const dividerLine = colWidths
    .map((w) => `${ANSI.gray}${'-'.repeat(w)}${ANSI.reset}`)
    .join('  ');

  const formattedRows = rows.map((row) =>
    row
      .map((cell, i) => {
        const raw = cell || '';
        const plain = stripAnsi(raw);
        const w = colWidths[i];
        if (plain.length > w) {
          return raw.slice(0, w - 1) + '…';
        }
        return raw + ' '.repeat(Math.max(0, w - plain.length));
      })
      .join('  ')
  );

  return [headerLine, dividerLine, ...formattedRows].join('\n');
}

export function formatHumanOutput(command: string, result: any, cliCommand?: string): string {
  if (!result) return `${ANSI.gray}(empty result)${ANSI.reset}`;

  // Raw REST passthrough: show the HTTP status, then the payload. Only `snu
  // rest` lands here; `snu record create` rides the same bridge command but is
  // reshaped into a {created, sys_id} envelope first.
  if (cliCommand === 'rest') {
    const status = result.status;
    const badge =
      typeof status === 'number' && status >= 200 && status < 300
        ? `${ANSI.green}${status}${ANSI.reset}`
        : `${ANSI.yellow}${status ?? '?'}${ANSI.reset}`;
    const payload = result.data === undefined ? result : result.data;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return `\n${ANSI.bold}HTTP ${badge}${ANSI.reset}\n${body}\n`;
  }

  // Staged Write Response
  if (result.staged === true) {
    return (
      `\n${ANSI.yellow}${ANSI.bold}[Staged]${ANSI.reset} ` +
      `${result.message || 'Write staged for review in VS Code.'}\n` +
      `${ANSI.gray}Review ID: ${result.reviewId || 'n/a'} · Approve in Pending Saves queue or via Sync Now in VS Code.${ANSI.reset}\n`
    );
  }

  // 1. Context
  if (command === 'get_context') {
    const lines: string[] = [''];
    const bridgeBadge = result.bridgeReady
      ? `${ANSI.green}● Active${ANSI.reset}`
      : `${ANSI.red}● Inactive${ANSI.reset}`;
    const snBadge = result.serviceNowReady
      ? `${ANSI.green}● Connected${ANSI.reset}`
      : result.browserConnected
      ? `${ANSI.yellow}● Browser Connected (No License / Session)${ANSI.reset}`
      : `${ANSI.yellow}○ Disconnected${ANSI.reset}`;

    lines.push(`${ANSI.bold}ScriptSync Bridge Status:${ANSI.reset}`);
    lines.push(`  Bridge Daemon:    ${bridgeBadge}`);
    lines.push(`  ServiceNow Tab:   ${snBadge}`);

    if (result.helper) {
      lines.push(`  Helper Tier:      ${ANSI.cyan}${result.helper.tier || 'Free'}${ANSI.reset}${result.helper.proFeatures ? ` (${ANSI.green}Pro Active${ANSI.reset})` : ''}`);
    }

    if (
      result.security?.instance &&
      result.security?.effectiveGates &&
      (result.security.hostGates || result.security.instanceGateProtocol)
    ) {
      const target = result.security.instance;
      const targetLabel = target.origin ? `${target.name} (${target.origin})` : target.name;
      lines.push(`\n${ANSI.bold}Security Policy for ${targetLabel}:${ANSI.reset}`);
      const labels: Record<string, string> = {
        backgroundScripts: 'Background Scripts',
        deleteRecords: 'Delete Records',
        createArtifacts: 'Create Artifacts',
        updateRecords: 'Update Records',
        browserDebugger: 'Browser Debugger',
        restRequest: 'REST Request API',
      };
      const hostLabel = (value: boolean | null) => value === null ? `${ANSI.gray}—${ANSI.reset}` : value ? `${ANSI.green}On${ANSI.reset}` : `${ANSI.gray}Off${ANSI.reset}`;
      const instanceLabel = (value: string | null) => {
        if (value === null) return `${ANSI.gray}—${ANSI.reset}`;
        if (value === 'missing') return `${ANSI.red}Missing${ANSI.reset}`;
        if (value === 'off') return `${ANSI.gray}Off${ANSI.reset}`;
        if (value === 'approve') return `${ANSI.yellow}Approve${ANSI.reset}`;
        return `${ANSI.green}${value === 'auto' ? 'Auto' : 'On'}${ANSI.reset}`;
      };
      const resultLabel = (value: string) => {
        if (value === 'blocked_host') return `${ANSI.red}Blocked by host${ANSI.reset}`;
        if (value === 'blocked_instance') return `${ANSI.red}Blocked by instance${ANSI.reset}`;
        if (value === 'approval_required') return `${ANSI.yellow}Approval required${ANSI.reset}`;
        if (value === 'allowed') return `${ANSI.green}Allowed${ANSI.reset}`;
        return `${ANSI.gray}Unknown${ANSI.reset}`;
      };
      // Only render gates the payload actually carries: an older bridge does not
      // report every gate this build knows about.
      const rows = Object.keys(labels).flatMap((key) => {
        const gate = result.security.effectiveGates[key];
        if (!gate) return [];
        return [[labels[key], hostLabel(gate.host), instanceLabel(gate.instance), resultLabel(gate.result)]];
      });
      lines.push(formatTable(['Permission', 'Host', 'Instance', 'Effective'], rows).split('\n').map((line) => `  ${line}`).join('\n'));
    } else if (result.gates) {
      lines.push(`\n${ANSI.bold}Standalone Host Permission Gates:${ANSI.reset}`);
      const formatGate = (label: string, enabled?: boolean) => {
        const badge = enabled ? `${ANSI.green}● Enabled${ANSI.reset}` : `${ANSI.gray}○ Disabled${ANSI.reset}`;
        return `  • ${label.padEnd(22)} ${badge}`;
      };
      lines.push(formatGate('Background Scripts', result.gates.backgroundScripts));
      lines.push(formatGate('Delete Records', result.gates.deleteRecords));
      lines.push(formatGate('Create Artifacts', result.gates.createArtifacts));
      lines.push(formatGate('Update Records', result.gates.updateRecords));
      lines.push(formatGate('Browser Debugger', result.gates.browserDebugger));
      lines.push(formatGate('REST Request API', result.gates.restRequest));
      if (result.security?.instanceGateProtocol) {
        const policies = result.security.availableInstancePolicies || [];
        if (policies.length > 0) {
          lines.push(`  ${ANSI.gray}Instance policies: ${policies.map((item: any) => item.name).join(', ')}${ANSI.reset}`);
        }
        lines.push(`  ${ANSI.gray}Run snu context --instance <name> to show a combined policy.${ANSI.reset}`);
      }
    }

    if (result.instances && result.instances.length > 0) {
      lines.push(`\n${ANSI.bold}Available Instances (${result.instances.length}):${ANSI.reset}`);
      for (const inst of result.instances) {
        const isDefault = inst.name === result.defaultInstance ? ` ${ANSI.cyan}(default)${ANSI.reset}` : '';
        const activeAge = inst.lastActiveAgeMs !== null ? `${ANSI.gray}${Math.round(inst.lastActiveAgeMs / 60000)}m ago${ANSI.reset}` : `${ANSI.gray}never active${ANSI.reset}`;
        lines.push(`  • ${ANSI.bold}${inst.name}${ANSI.reset}${isDefault} → ${inst.url || '(no URL)'} [${activeAge}]`);
      }
    }

    if (result.message && !result.serviceNowReady) {
      lines.push(`\n${ANSI.yellow}Note: ${result.message}${ANSI.reset}`);
    }

    return lines.join('\n');
  }

  // 2. Code Search
  if (command === 'code_search') {
    const lines: string[] = [];
    const stats = result.stats || {};
    lines.push(
      `\n${ANSI.bold}Search Results for "${result.term}":${ANSI.reset} ` +
      `${ANSI.gray}(${stats.matches || 0} matches across ${stats.records || 0} records in ${stats.tables || 0} tables)${ANSI.reset}\n`
    );

    const tables = result.results || [];
    if (tables.length === 0) {
      lines.push(`${ANSI.gray}No matches found.${ANSI.reset}`);
    } else {
      for (const t of tables) {
        lines.push(`${ANSI.bold}${ANSI.cyan}${t.label} (${t.table})${ANSI.reset} — ${t.hits?.length || 0} match(es)`);
        for (const hit of t.hits || []) {
          const matchField = hit.field ? ` (${hit.field})` : '';
          lines.push(`  • ${hit.name || hit.sys_id}${matchField} [${hit.sys_id}]`);
          if (hit.matches && hit.matches.length > 0) {
            for (const m of hit.matches.slice(0, 3)) {
              lines.push(`    ${ANSI.gray}Line ${m.line}:${ANSI.reset} ${m.preview?.trim()}`);
            }
          }
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  // 3. Schema
  if (command === 'get_table_metadata') {
    const fields = Array.isArray(result) ? result : result.fields || result.columns || [];
    if (!Array.isArray(fields) || fields.length === 0) {
      return '\n' + JSON.stringify(result, null, 2) + '\n';
    }

    const headers = ['Element', 'Label', 'Type', 'Max Len', 'Mandatory', 'Reference'];
    const rows = fields.map((f: any) => [
      f.name || f.element || '',
      f.label || '',
      f.type || '',
      String(f.max_length || f.length || ''),
      f.mandatory === true || f.mandatory === 'true' ? 'Yes' : 'No',
      f.reference || '',
    ]);

    return `\n${ANSI.bold}Schema Dictionary (${fields.length} columns):${ANSI.reset}\n\n` + formatTable(headers, rows) + '\n';
  }

  // 4. Query Records
  if (command === 'query_records') {
    const records = result.records || (Array.isArray(result) ? result : []);
    if (!Array.isArray(records) || records.length === 0) {
      return `\n${ANSI.gray}No records returned.${ANSI.reset}\n`;
    }

    // Extract columns from first record
    const first = records[0];
    const candidateKeys = Object.keys(first).filter((k) => !k.startsWith('@') && typeof first[k] !== 'object');
    const priority = ['sys_id', 'number', 'name', 'short_description', 'sys_updated_on', 'sys_created_on'];
    const selectedHeaders = [
      ...priority.filter((k) => candidateKeys.includes(k)),
      ...candidateKeys.filter((k) => !priority.includes(k)),
    ].slice(0, 5);

    const rows = records.map((r: any) =>
      selectedHeaders.map((h) => {
        const val = r[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object' && val.display_value !== undefined) return String(val.display_value);
        return String(val);
      })
    );

    return `\n` + formatTable(selectedHeaders, rows) + `\n\n${ANSI.gray}Showing ${records.length} record(s) on ${result.table || 'table'}.${ANSI.reset}\n`;
  }

  // 5. Run Background Script Output
  if (command === 'run_background_script') {
    const out = result.output || result.data || '';
    return `\n${ANSI.bold}Script Output:${ANSI.reset}\n----------------------------------------\n${out}\n----------------------------------------\n`;
  }

  // 6. Generic Object/Status Responses
  if (result.created) {
    const label = result.name ? `${result.name} (${result.sys_id})` : String(result.sys_id || '');
    return `\n${ANSI.green}✓ Created ${result.table || 'artifact'}:${ANSI.reset} ${label}\n`;
  }
  if (result.updated) {
    return `\n${ANSI.green}✓ Updated record:${ANSI.reset} ${result.sys_id} (${result.field || 'field'})\n`;
  }
  if (result.deleted) {
    return `\n${ANSI.green}✓ Deleted record:${ANSI.reset} ${result.sys_id || result.name || ''}\n`;
  }
  if (result.dryRun) {
    return `\n${ANSI.yellow}[Dry Run] Target record that would be deleted:${ANSI.reset}\n${JSON.stringify(result.record, null, 2)}\n`;
  }
  if (result.saved && result.filePath) {
    return `\n${ANSI.green}✓ Screenshot saved to:${ANSI.reset} ${result.filePath}\n`;
  }

  return '\n' + JSON.stringify(result, null, 2) + '\n';
}

/**
 * Output strict JSON on stdout on success.
 */
export function outputJson(data: any): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

/**
 * Output structured error on stderr.
 */
export function outputError(err: any, isJsonMode = false): void {
  const errorObj = {
    status: 'error',
    error: err?.message || String(err),
    code: err?.code || 'E_COMMAND_FAILED',
    status_code: err?.status || null,
    details: err?.details || null,
  };

  if (isJsonMode) {
    process.stderr.write(JSON.stringify(errorObj, null, 2) + '\n');
  } else {
    if (err?.code === 'E_USER_REJECTED') {
      const feedback = err.details?.userFeedback || err.message;
      process.stderr.write(
        `\n${ANSI.red}${ANSI.bold}✕ Execution rejected by developer:${ANSI.reset} "${feedback}" ${ANSI.gray}(E_USER_REJECTED)${ANSI.reset}\n`
      );
    } else if (err?.code === 'E_BROWSER_DISCONNECTED') {
      // Setup state, not a tool failure: guide instead of alarming.
      const steps: string[] = Array.isArray(err.details?.guidance) && err.details.guidance.length
        ? err.details.guidance
        : ['Open your ServiceNow instance in the browser, type /token in the SN Utils slash palette to open the helper tab, keep it open, then retry.'];
      process.stderr.write(
        `\n${ANSI.yellow}${ANSI.bold}ServiceNow is not connected${ANSI.reset} ${ANSI.gray}(the SN Utils helper tab is not open)${ANSI.reset}\n\n` +
        steps.map((s, i) => `  ${ANSI.cyan}${i + 1}.${ANSI.reset} ${s}`).join('\n') +
        `\n\n${ANSI.gray}Check readiness any time with: snu context${ANSI.reset}\n`
      );
    } else {
      process.stderr.write(
        `\n${ANSI.red}${ANSI.bold}Error:${ANSI.reset} ${err?.message || err}\n` +
        (err?.code ? `${ANSI.gray}Code: ${err.code}${ANSI.reset}\n` : '')
      );
    }
  }
}
