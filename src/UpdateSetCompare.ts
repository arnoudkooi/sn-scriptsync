import * as fs from 'fs';
import * as path from 'path';
import { Constants } from './constants';
import { xml2js, Element } from 'xml-js';

/** Read only the requested record/field; preserve whitespace and empty values. */
export function updateSetField(payload: string, table: string, sysId: string, field: string): string {
	const doc = xml2js(payload, { compact: false, ignoreComment: true }) as Element;
	const root = doc.elements?.find(e => e.type === 'element' && e.name === 'record_update');
	const record = root?.elements?.find(e => e.type === 'element' && e.name === table);
	if (!record) throw new Error('The customer update does not contain this record type.');
	const text = (e: Element) => (e.elements || []).map(c => c.type === 'cdata' ? c.cdata : c.type === 'text' ? c.text : '').join('');
	if (text(record.elements?.find(e => e.name === 'sys_id') || {}) !== sysId) throw new Error('The customer update belongs to a different record.');
	if (record.attributes?.action === 'DELETE') throw new Error('This customer update deletes the record; no field baseline is available.');
	const element = record.elements?.find(e => e.type === 'element' && e.name === field);
	if (!element) throw new Error(`The customer update has no readable ${field} field.`);
	if (element.elements?.some(e => e.type === 'element')) throw new Error('This field contains structured XML and cannot be compared as a script.');
	return text(element);
}

/** Scan only the record's immediate directory (or legacy field directories). */
export function recordFieldFiles(file: string, record: any): string[] {
	const directory = path.dirname(file);
	const names = fs.readdirSync(directory, { withFileTypes: true });
	const folderRecord = Constants.FOLDERRECORDTABLES.includes(record.tableName);
	const candidates = names.filter(entry => entry.isFile() && !entry.name.startsWith('_') &&
		(folderRecord || entry.name.startsWith(record.name + '.') || entry.name.includes(record.sys_id)))
		.map(entry => path.join(directory, entry.name));
	// Legacy layout: table/field/name.sys_id.ext.
	if (path.basename(directory) === record.fieldName) {
		for (const entry of fs.readdirSync(path.dirname(directory), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const fieldDirectory = path.join(path.dirname(directory), entry.name);
			for (const name of fs.readdirSync(fieldDirectory, { withFileTypes: true })) {
				if (name.isFile() && name.name.includes(record.sys_id)) candidates.push(path.join(fieldDirectory, name.name));
			}
		}
	}
	return [...new Set([file, ...candidates])];
}

/** Only advanced comparisons need a resolved Pro entitlement (includes Trial). */
export function updateSetComparisonAccess(choose: boolean, allFields: boolean, license: { licenseResolved?: boolean; proFeatures?: boolean } | null | undefined): 'allowed' | 'unresolved' | 'proRequired' {
	if (!choose && !allFields) return 'allowed';
	if (!license?.licenseResolved) return 'unresolved';
	return license.proFeatures === true ? 'allowed' : 'proRequired';
}

export interface HistoryBaseline {
	table: 'sys_update_xml' | 'sys_update_version'; id: string; label: string; date: string; author: string;
	state: string; link: string; payload: string; completed?: boolean; current?: boolean;
}

/** Current saved version is not a useful previous-version baseline. */
export function previousFieldBaseline(entries: HistoryBaseline[], table: string, id: string, field: string, current: string): HistoryBaseline | undefined {
	const normalized = (text: string) => text.replace(/\r\n/g, '\n');
	return entries.find(entry => {
		try { return normalized(updateSetField(entry.payload, table, id, field)) !== normalized(current); }
		catch { return false; }
	});
}

/** sys_recorded_at is an internal ordering token, not a displayable date. */
export function historyDate(table: HistoryBaseline['table'], created: string, updated: string): string {
	const valid = (value: string) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
	const preferred = table === 'sys_update_version' ? created : updated;
	return valid(preferred) ? preferred : valid(updated) ? updated : valid(created) ? created : '';
}

export function sortHistory(entries: HistoryBaseline[]): HistoryBaseline[] {
	return entries.sort((a, b) => Number(!!b.current) - Number(!!a.current) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/** History access is often restricted to admins; expose a useful explanation. */
export function historyReadError(table: string, error: unknown): string {
	const source = table === 'sys_update_version' ? 'Record versions' : 'Customer updates';
	const message = error instanceof Error ? error.message : String(error);
	if (/\b403\b|forbidden|access denied/i.test(message)) return `${source} are not readable with your current ServiceNow permissions. Ask your administrator for read access.`;
	if (/\b401\b|not authenticated/i.test(message)) return `${source} could not be read because your ServiceNow session expired. Sign in again and reconnect the helper tab.`;
	return `${source} could not be read: ${message}`;
}

/** Cache only requested snapshots, including concurrent requests for the same entry. */
export function historyPayloadReader(fetch: (entry: HistoryBaseline) => Promise<string>) {
	const cache = new Map<string, Promise<string>>();
	return (entry: HistoryBaseline): Promise<string> => {
		const key = `${entry.table}:${entry.id}`;
		let pending = cache.get(key);
		if (!pending) {
			pending = fetch(entry).then(payload => { entry.payload = payload; return payload; });
			cache.set(key, pending);
		}
		return pending;
	};
}

export async function findHistoryBaseline(entries: HistoryBaseline[], table: string, id: string, field: string, current: string, readPayload: (entry: HistoryBaseline) => Promise<string>): Promise<HistoryBaseline | undefined> {
	for (const entry of entries) {
		// A denied source must not prevent a later readable source from being used.
		try {
			await readPayload(entry);
			if (previousFieldBaseline([entry], table, id, field, current)) return entry;
		} catch {}
	}
	return undefined;
}

/** A refresh may dispose a panel while its action is still completing. */
export async function historyActionFeedback(disposed: () => boolean, post: () => PromiseLike<unknown>): Promise<void> {
	if (disposed()) return;
	try { await post(); } catch { /* It may also close between the check and post. */ }
}
