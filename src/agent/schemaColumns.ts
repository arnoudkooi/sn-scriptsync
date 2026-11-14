// Mirrored in both hosts (src/agent/schemaColumns.ts); scripts/test-bridge-parity.mjs
// checks that the two files stay identical.

/**
 * One column of a table schema. The first four keys come from the REST API
 * documentation endpoint (/api/now/doc/table/schema) and keep their names for
 * existing callers. exampleValue is a generated sample from that
 * documentation, never record data. Every other key comes from the
 * instance's form metadata (/api/now/ui/meta) and is left out when it could
 * not be read, so a missing key means unknown, not false.
 */
export interface SchemaColumn {
    name: string;
    label?: string;
    internalType?: string;
    exampleValue?: string;
    type?: string;
    reference?: string;
    mandatory?: boolean;
    readOnly?: boolean;
    maxLength?: number;
    defaultValue?: string;
    choiceCount?: number;
    choices?: Array<{ value: string; label: string }>;
}

export interface SchemaOptions { choices?: boolean; }

const FIELD_NAME = /^[A-Za-z0-9_.$]+$/;

function text(value: any): string | undefined {
    return typeof value === 'string' ? value : (typeof value === 'number' || typeof value === 'boolean') ? String(value) : undefined;
}

function flag(value: any): boolean | undefined {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
}

/** The ui/meta columns map, whether given the response body, its result, or the map itself. */
export function uiMetaColumns(body: any): Record<string, any> {
    const map = body?.result?.columns ?? body?.columns ?? body;
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

function metaKeys(meta: any, options: SchemaOptions): Partial<SchemaColumn> {
    if (!meta || typeof meta !== 'object') return {};
    const out: Partial<SchemaColumn> = {};
    const reference = text(meta.reference);
    if (reference) out.reference = reference;
    const mandatory = flag(meta.mandatory);
    if (mandatory !== undefined) out.mandatory = mandatory;
    const readOnly = flag(meta.read_only);
    if (readOnly !== undefined) out.readOnly = readOnly;
    const maxLength = Number(meta.max_length);
    if (meta.max_length !== undefined && meta.max_length !== '' && Number.isFinite(maxLength)) out.maxLength = maxLength;
    const defaultValue = text(meta.default);
    if (defaultValue) out.defaultValue = defaultValue;
    if (Array.isArray(meta.choices)) {
        const choices = meta.choices
            .filter((c: any) => c && typeof c === 'object' && text(c.value) !== undefined && c.value !== '')
            .map((c: any) => ({ value: text(c.value)!, label: text(c.label) ?? text(c.value)! }));
        if (choices.length) {
            out.choiceCount = choices.length;
            if (options.choices) out.choices = choices;
        }
    }
    return out;
}

/**
 * Merge the documentation columns with the form metadata, by column name.
 * The documentation order and keys are kept; metadata adds what it knows.
 * Columns only the metadata lists are appended. With no documentation
 * columns, the list is built from the metadata alone.
 */
export function enrichSchemaColumns(docColumns: any, uiMeta: any, options: SchemaOptions = {}): SchemaColumn[] {
    const meta = uiMetaColumns(uiMeta);
    const out: SchemaColumn[] = [];
    const seen = new Set<string>();
    if (Array.isArray(docColumns)) {
        for (const doc of docColumns) {
            if (!doc || typeof doc !== 'object') continue;
            const name = text(doc.name ?? doc.element);
            if (!name) continue;
            seen.add(name);
            const m = meta[name];
            const type = text(doc.internalType) || text(doc.type) || text(m?.internal_type);
            out.push({ ...doc, name, ...(type ? { type } : {}), ...metaKeys(m, options) });
        }
    }
    for (const [key, m] of Object.entries<any>(meta)) {
        const name = text(m?.name) || key;
        if (seen.has(name) || !FIELD_NAME.test(name)) continue;
        seen.add(name);
        const type = text(m?.internal_type) || text(m?.type);
        out.push({
            name,
            ...(text(m?.label) ? { label: text(m.label) } : {}),
            ...(type ? { internalType: type, type } : {}),
            ...metaKeys(m, options),
        });
    }
    return out;
}
