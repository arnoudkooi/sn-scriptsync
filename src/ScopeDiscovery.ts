// Mirrored in packages/snu/src/server/scopeDiscovery.ts for the standalone build;
// scripts/test-bridge-parity.mjs checks that the two files stay identical.
export interface Pagination { link?: string | null; totalCount?: string | null; }
export interface PageResult { rows: any[]; pagination?: Pagination; }
export interface PageState { nextOffset?: number; complete: boolean; warning?: string; }
export function pageState(paging: Pagination | undefined, offset: number, size: number, received: number): PageState {
    if (paging?.link) {
        const next = paging.link.split(/,(?=\s*<)/).find(part => /;\s*rel=["']?next(?:["';\s]|$)/i.test(part));
        if (next) {
            const target = next.match(/<([^>]+)>/);
            const raw = target ? new URL(target[1], 'https://pagination.invalid').searchParams.get('sysparm_offset') : null;
            const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
            if (!Number.isSafeInteger(value) || value <= offset) throw new Error('Invalid next-page offset in ServiceNow response');
            return { nextOffset: value, complete: false };
        }
    }
    const rawTotal = paging?.totalCount;
    if (typeof rawTotal === 'string' && /^\d+$/.test(rawTotal)) {
        const total = Number(rawTotal);
        if (!Number.isSafeInteger(total)) throw new Error('Invalid record count in ServiceNow response');
        return offset + size < total ? { nextOffset: offset + size, complete: false } : { complete: true };
    }
    if (paging?.link) return { complete: true };
    if (received >= size) return { nextOffset: offset + size, complete: false };
    return { complete: false, warning: 'Pagination could not be verified. Update SN Utils and reload its helper tab; this load may be incomplete.' };
}

export type FetchPage = (table: string, query: Record<string, string>) => Promise<PageResult>;
/**
 * The instance's own count of records matching an encoded query, or
 * undefined when it cannot be read. Used only when paging headers are
 * missing: a short page alone does not prove the read is complete.
 */
export type CountRows = (table: string, query: string) => Promise<number | undefined>;
/** Hard stop for one read: 200 pages of 500 records. */
export const MAX_PAGES = 200;

export async function readAllPages(fetchPage: FetchPage, table: string, query: string, fields: string, countRows?: CountRows) {
    const rows: any[] = [];
    const warnings: string[] = [];
    let total: number | undefined;
    for (let offset = 0, pages = 0; ; pages++) {
        if (pages >= MAX_PAGES) {
            warnings.push(`${table}: stopped after ${MAX_PAGES} pages (${rows.length} records); this load is incomplete.`);
            return { rows, warnings, complete: false };
        }
        const page = await fetchPage(table, {
            sysparm_query: query, sysparm_fields: fields, sysparm_limit: '500', sysparm_offset: String(offset),
            sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true', sysparm_no_count: 'false',
        });
        if (!Array.isArray(page.rows)) throw new Error(`Invalid records response from ${table}`);
        for (const row of page.rows) rows.push(row);
        if (page.pagination?.totalCount && /^\d+$/.test(page.pagination.totalCount)) total = Number(page.pagination.totalCount);
        const state = pageState(page.pagination, offset, 500, page.rows.length);
        if (state.nextOffset === undefined) {
            let complete = state.complete;
            if (state.warning) {
                // No paging headers: ask the instance how many records match.
                // Equal or fewer than received proves the read complete; a
                // missing or higher count leaves it incomplete.
                let expected: number | undefined;
                try { expected = countRows ? await countRows(table, query) : undefined; } catch { expected = undefined; }
                if (expected !== undefined && Number.isSafeInteger(expected) && expected >= 0 && rows.length >= expected) complete = true;
                else {
                    warnings.push(`${table}: ${state.warning}`);
                    if (expected !== undefined && Number.isSafeInteger(expected)) total = expected;
                }
            }
            if (total !== undefined && total > rows.length) warnings.push(`${table}: ${total - rows.length} matching records were not returned; access controls or records changing during the load may account for the difference.`);
            return { rows, warnings, complete };
        }
        offset = state.nextOffset;
    }
}

const SCRIPT_TYPES = new Set(['script', 'script_plain', 'script_server', 'script_client', 'email_script', 'html_script',
    'xml', 'html', 'html_template', 'template', 'json', 'css', 'condition_string', 'expression', 'graphql_schema',
    'json_translations', 'translated_html']);
export function scalar(value: any): string { return String(value && typeof value === 'object' ? value.value ?? '' : value ?? ''); }
export interface FieldDefinition { label: string; type: string; }
export interface TableDefinition { label?: string; group?: string; codeFields?: Record<string, FieldDefinition>; referenceFields?: Record<string, any>; }

/**
 * The dictionary supplies fields, including inherited fields; the snapshot
 * supplies grouping and a warned fallback. A failed or incomplete read
 * affects only the tables whose own chain it covers. `established` lists the
 * tables whose fields came from a complete live dictionary: only those may be
 * reported as having no scriptable fields.
 */
export async function discoverScopeFields(tables: string[], bundled: Record<string, TableDefinition>, fetchPage: FetchPage, countRows?: CountRows) {
    const definitions: Record<string, TableDefinition> = {};
    const warnings: string[] = [];
    const established = new Set<string>();
    const fallback = (table: string, reason: string) => {
        definitions[table] = JSON.parse(JSON.stringify(bundled[table] || { label: table }));
        warnings.push(`${table}: ${reason}; using bundled field definitions where available.`);
    };
    const reasonOf = (error: any, fallbackReason: string) => String(error?.message || fallbackReason).replace(/\s+/g, ' ').slice(0, 300);

    // Inheritance. Rows from an incomplete read are still used: the chain walk
    // below checks every link, so a missing row leaves its table unresolved
    // instead of producing a wrong chain.
    const parents = new Map<string, string>();
    const unresolved = new Map<string, string>();
    let needed = [...new Set(tables)];
    for (let depth = 0; needed.length; depth++) {
        if (depth >= 32) { for (const name of needed) unresolved.set(name, 'Table inheritance exceeds 32 levels'); break; }
        const next = new Set<string>();
        for (let i = 0; i < needed.length; i += 100) {
            const batch = needed.slice(i, i + 100);
            try {
                const result = await readAllPages(fetchPage, 'sys_db_object', `nameIN${batch.join(',')}^ORDERBYsys_id`, 'name,super_class.name', countRows);
                const note = result.complete && !result.warnings.length ? '' : (result.warnings[0] || 'Table inheritance discovery was incomplete');
                for (const row of result.rows) {
                    const name = scalar(row.name), parent = scalar(row['super_class.name']);
                    if (!/^[a-zA-Z0-9_]+$/.test(name) || (parent && !/^[a-zA-Z0-9_]+$/.test(parent))) continue;
                    parents.set(name, parent);
                    if (parent && !parents.has(parent)) next.add(parent);
                }
                if (note) for (const name of batch) if (!parents.has(name)) unresolved.set(name, `Table inheritance discovery was incomplete (${note})`);
            } catch (error: any) {
                for (const name of batch) unresolved.set(name, `Table inheritance discovery failed: ${reasonOf(error, 'unknown error')}`);
            }
        }
        needed = [...next].filter(name => !parents.has(name) && !unresolved.has(name));
    }

    // Dictionary rows per table. An incomplete batch could be missing fields,
    // so every table it covers is marked failed rather than trusted.
    const dictionary = new Map<string, any[]>();
    const failed = new Map<string, string>();
    const names = [...parents.keys()];
    for (let i = 0; i < names.length; i += 100) {
        const batch = names.slice(i, i + 100);
        try {
            const result = await readAllPages(fetchPage, 'sys_dictionary', `nameIN${batch.join(',')}^elementISNOTEMPTY^ORDERBYsys_id`, 'name,element,column_label,internal_type,reference', countRows);
            if (!result.complete || result.warnings.length) {
                const note = result.warnings[0] || 'Dictionary discovery was incomplete';
                for (const name of batch) failed.set(name, `Dictionary discovery was incomplete (${note})`);
                continue;
            }
            for (const row of result.rows) {
                const name = scalar(row.name);
                if (!dictionary.has(name)) dictionary.set(name, []);
                dictionary.get(name)!.push(row);
            }
        } catch (error: any) {
            for (const name of batch) failed.set(name, `Dictionary discovery failed: ${reasonOf(error, 'unknown error')}`);
        }
    }

    for (const table of tables) {
        const chain: string[] = [];
        const seen = new Set<string>();
        let name = table;
        while (name && parents.has(name) && !seen.has(name)) { seen.add(name); chain.push(name); name = parents.get(name)!; }
        if (name || !chain.length) { fallback(table, unresolved.get(name || table) || 'Instance dictionary unavailable'); continue; }
        const failedLink = chain.find(n => failed.has(n));
        if (failedLink) { fallback(table, failed.get(failedLink)!); continue; }
        if (!chain.some(n => dictionary.has(n))) { fallback(table, 'Instance dictionary unavailable'); continue; }
        const fields: Record<string, any> = {};
        for (const ancestor of chain.reverse()) for (const row of dictionary.get(ancestor) || []) fields[scalar(row.element)] = row;
        // The stored internal_type value is the type name itself; reading it
        // directly also works when its sys_glide_object record is missing.
        const typeOf = (row: any) => scalar(row.internal_type) || scalar(row['internal_type.name']);
        if (Object.values<any>(fields).some(row => !typeOf(row))) { fallback(table, 'Field types were not readable'); continue; }
        const codeFields: Record<string, FieldDefinition> = {};
        const referenceFields: Record<string, any> = {};
        for (const [field, row] of Object.entries(fields)) {
            if (!/^[a-zA-Z0-9_]+$/.test(field)) continue;
            const type = typeOf(row);
            if (SCRIPT_TYPES.has(type)) codeFields[field] = { label: scalar(row.column_label) || field, type };
            if (type === 'reference' && !['sys_scope', 'sys_package'].includes(field)) referenceFields[field] = { table: scalar(row.reference), label: scalar(row.column_label) || field };
        }
        definitions[table] = { ...bundled[table], label: bundled[table]?.label || table, group: bundled[table]?.group || 'other', codeFields, referenceFields };
        established.add(table);
    }
    return { definitions, warnings, established };
}
