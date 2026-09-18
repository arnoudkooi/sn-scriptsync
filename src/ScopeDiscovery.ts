// Mirrored in packages/snu/src/server/scopeDiscovery.ts for the standalone build.
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
export async function readAllPages(fetchPage: FetchPage, table: string, query: string, fields: string) {
    const rows: any[] = [];
    const warnings: string[] = [];
    let total: number | undefined;
    for (let offset = 0; ;) {
        const page = await fetchPage(table, {
            sysparm_query: query, sysparm_fields: fields, sysparm_limit: '500', sysparm_offset: String(offset),
            sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true', sysparm_no_count: 'false',
        });
        if (!Array.isArray(page.rows)) throw new Error(`Invalid records response from ${table}`);
        for (const row of page.rows) rows.push(row);
        if (page.pagination?.totalCount && /^\d+$/.test(page.pagination.totalCount)) total = Number(page.pagination.totalCount);
        const state = pageState(page.pagination, offset, 500, page.rows.length);
        if (state.nextOffset === undefined) {
            if (state.warning) warnings.push(`${table}: ${state.warning}`);
            if (total !== undefined && total > rows.length) warnings.push(`${table}: ${total - rows.length} matching records were not returned; access controls or records changing during the load may account for the difference.`);
            return { rows, warnings, complete: state.complete };
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

/** The dictionary supplies fields, including inherited fields; the snapshot supplies grouping and a warned fallback. */
export async function discoverScopeFields(tables: string[], bundled: Record<string, TableDefinition>, fetchPage: FetchPage) {
    const definitions: Record<string, TableDefinition> = {};
    const warnings: string[] = [];
    const fallback = (table: string, reason: string) => {
        definitions[table] = JSON.parse(JSON.stringify(bundled[table] || { label: table }));
        warnings.push(`${table}: ${reason}; using bundled field definitions where available.`);
    };
    try {
        const parents = new Map<string, string>();
        let needed = [...new Set(tables)];
        for (let depth = 0; needed.length; depth++) {
            if (depth >= 32) throw new Error('Table inheritance exceeds 32 levels');
            const next = new Set<string>();
            for (let i = 0; i < needed.length; i += 100) {
                const batch = needed.slice(i, i + 100);
                const result = await readAllPages(fetchPage, 'sys_db_object', `nameIN${batch.join(',')}^ORDERBYsys_id`, 'name,super_class.name');
                if (!result.complete || result.warnings.length) throw new Error('Table inheritance discovery was incomplete');
                for (const row of result.rows) {
                    const name = scalar(row.name), parent = scalar(row['super_class.name']);
                    if (!/^[a-zA-Z0-9_]+$/.test(name) || (parent && !/^[a-zA-Z0-9_]+$/.test(parent))) continue;
                    parents.set(name, parent);
                    if (parent && !parents.has(parent)) next.add(parent);
                }
            }
            needed = [...next].filter(name => !parents.has(name));
        }
        const dictionary = new Map<string, any[]>();
        const names = [...parents.keys()];
        for (let i = 0; i < names.length; i += 100) {
            const result = await readAllPages(fetchPage, 'sys_dictionary', `nameIN${names.slice(i, i + 100).join(',')}^elementISNOTEMPTY^ORDERBYsys_id`, 'name,element,column_label,internal_type.name,reference');
            if (!result.complete || result.warnings.length) throw new Error('Dictionary discovery was incomplete');
            for (const row of result.rows) {
                const name = scalar(row.name);
                if (!dictionary.has(name)) dictionary.set(name, []);
                dictionary.get(name)!.push(row);
            }
        }
        for (const table of tables) {
            const chain: string[] = [];
            const seen = new Set<string>();
            let name = table;
            while (name && parents.has(name) && !seen.has(name)) { seen.add(name); chain.push(name); name = parents.get(name)!; }
            if (name || !chain.length || !chain.some(n => dictionary.has(n))) { fallback(table, 'Instance dictionary unavailable'); continue; }
            const fields: Record<string, any> = {};
            for (const ancestor of chain.reverse()) for (const row of dictionary.get(ancestor) || []) fields[scalar(row.element)] = row;
            if (Object.values<any>(fields).some(row => !scalar(row['internal_type.name']))) { fallback(table, 'Field types were not readable'); continue; }
            const codeFields: Record<string, FieldDefinition> = {};
            const referenceFields: Record<string, any> = {};
            for (const [field, row] of Object.entries(fields)) {
                if (!/^[a-zA-Z0-9_]+$/.test(field)) continue;
                const type = scalar(row['internal_type.name']);
                if (SCRIPT_TYPES.has(type)) codeFields[field] = { label: scalar(row.column_label) || field, type };
                if (type === 'reference' && !['sys_scope', 'sys_package'].includes(field)) referenceFields[field] = { table: scalar(row.reference), label: scalar(row.column_label) || field };
            }
            definitions[table] = { ...bundled[table], label: bundled[table]?.label || table, group: bundled[table]?.group || 'other', codeFields, referenceFields };
        }
    } catch (error: any) {
        for (const table of tables) fallback(table, error.message || 'Instance dictionary unavailable');
    }
    return { definitions, warnings };
}
