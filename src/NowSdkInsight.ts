// What the NOW SDK App view shows about a project: the records in the built
// app, and the files edited since the last deploy. Kept free of `vscode`
// imports so it can be unit tested under plain Node.

import * as fs from 'fs';
import * as path from 'path';
import { listProjectFiles } from './NowSdkPull';

export interface AppRecord {
	table: string;
	sysId: string;
	name: string;
	/** Path on the instance that opens the record (or the page, for UI pages). */
	link: string;
}

export interface AppRecordGroup {
	table: string;
	label: string;
	records: AppRecord[];
}

/** Record types worth listing, in display order, with the field that names them. */
const GROUPS: Array<{ table: string; label: string; nameFields: string[] }> = [
	{ table: 'sys_db_object', label: 'Tables', nameFields: ['label', 'name'] },
	{ table: 'sys_dictionary', label: 'Columns', nameFields: ['element'] },
	{ table: 'sys_ui_page', label: 'UI Pages', nameFields: ['description', 'name', 'endpoint'] },
	{ table: 'sys_script_include', label: 'Script Includes', nameFields: ['name'] },
	{ table: 'sys_script', label: 'Business Rules', nameFields: ['name'] },
	{ table: 'sys_script_client', label: 'Client Scripts', nameFields: ['name'] },
	{ table: 'sys_ui_action', label: 'UI Actions', nameFields: ['name'] },
	{ table: 'sys_ui_policy', label: 'UI Policies', nameFields: ['short_description'] },
	{ table: 'sys_hub_flow', label: 'Flows and Subflows', nameFields: ['name'] },
	{ table: 'sys_hub_action_type_definition', label: 'Flow Actions', nameFields: ['name'] },
	{ table: 'sysauto_script', label: 'Scheduled Scripts', nameFields: ['name'] },
	{ table: 'sys_script_fix', label: 'Fix Scripts', nameFields: ['name'] },
	{ table: 'sys_ws_definition', label: 'Scripted REST APIs', nameFields: ['name'] },
	{ table: 'sp_widget', label: 'Widgets', nameFields: ['name'] },
	{ table: 'sys_properties', label: 'System Properties', nameFields: ['name'] },
	{ table: 'sys_user_role', label: 'Roles', nameFields: ['name'] },
	{ table: 'sys_security_acl', label: 'ACLs', nameFields: ['name'] },
	{ table: 'sys_app_application', label: 'Menus', nameFields: ['title'] },
	{ table: 'sys_app_module', label: 'Modules', nameFields: ['title'] },
	{ table: 'sys_module', label: 'Server Modules', nameFields: ['path'] },
];

function field(xml: string, name: string): string {
	const m = new RegExp(`<${name}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`).exec(xml);
	const value = m ? (m[1] ?? m[2] ?? '') : '';
	return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

/** The records in the built app (dist/app), grouped by type. Empty when the app was not built. */
export function readAppContents(appOutputDir: string): AppRecordGroup[] {
	let files: string[] = [];
	try {
		files = fs.readdirSync(path.join(appOutputDir, 'update')).filter((f) => f.endsWith('.xml'));
	} catch {
		return [];
	}
	const byTable = new Map<string, AppRecord[]>();
	for (const file of files) {
		let xml = '';
		try {
			xml = fs.readFileSync(path.join(appOutputDir, 'update', file), 'utf8');
		} catch {
			continue;
		}
		const table = /<record_update[^>]*>\s*<([a-z0-9_]+)\s/.exec(xml)?.[1];
		const group = GROUPS.find((g) => g.table === table);
		if (!table || !group) continue;
		const sysId = field(xml, 'sys_id');
		let name = group.nameFields.map((f) => field(xml, f)).find(Boolean) || sysId;
		if (table === 'sys_dictionary') {
			// The table's own dictionary entry has no element; it is not a column.
			if (!field(xml, 'element')) continue;
			name = `${field(xml, 'name')}.${name}`;
		}
		if (table === 'sys_security_acl') {
			const operation = /<operation[^>]*display_value="([^"]+)"/.exec(xml)?.[1] || field(xml, 'operation');
			if (operation) name = `${name} (${operation})`;
		}
		if (table === 'sys_module') {
			// Only the app's own source modules, not the SDK's bookkeeping files.
			if (/\/(bom|package)\.json$/.test(name)) continue;
			name = path.basename(name);
		}
		const link = table === 'sys_ui_page' && field(xml, 'endpoint')
			? field(xml, 'endpoint')
			: `${table}.do?sys_id=${sysId}`;
		const list = byTable.get(table) || [];
		list.push({ table, sysId, name, link });
		byTable.set(table, list);
	}
	return GROUPS.filter((g) => byTable.has(g.table)).map((g) => ({
		table: g.table,
		label: g.label,
		records: byTable.get(g.table)!.sort((a, b) => a.name.localeCompare(b.name)),
	}));
}

/** Project files changed after `sinceIso` (the last deploy), leaving out generated bookkeeping. */
export function filesEditedSince(projectRoot: string, sinceIso: string): string[] {
	const since = Date.parse(sinceIso);
	if (Number.isNaN(since)) return [];
	return listProjectFiles(projectRoot).filter((file) => {
		if (file.endsWith('generated/keys.ts') || file === 'package-lock.json') return false;
		try {
			return fs.statSync(path.join(projectRoot, file)).mtimeMs > since;
		} catch {
			return false;
		}
	});
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or a date. */
export function relativeTime(iso: string, now = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return '';
	const minutes = Math.round((now - then) / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days === 1) return 'yesterday';
	if (days < 7) return `${days} days ago`;
	return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
