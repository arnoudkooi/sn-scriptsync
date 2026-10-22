/**
 * Encoded-query validation for query_records.
 *
 * ServiceNow silently ignores a condition whose field path does not exist and
 * returns rows as if it were not there: `question.cat_item=…` on
 * question_choice returned 50 unrelated choices. Before a query runs, every
 * field path in `query`, `fields` and `orderBy` is checked hop by hop against
 * the column metadata (`/api/now/ui/meta/<table>`, inherited columns included).
 *
 * The outcome is an error or nothing:
 * - E_INVALID_QUERY: a path provably does not exist, or a non-reference field
 *   is dot-walked. The query is not run.
 * - E_QUERY_UNVERIFIABLE: a path could not be checked (columns unreadable, or
 *   the field/operator boundary not recognised). Without proof the query is
 *   not run either; `validate: false` is the explicit way past both.
 * - Otherwise the query runs and its result is unchanged.
 * Values are not judged: `javascript:gs.beginningOfToday()` is fine once its
 * field is. Known constructs (ORDERBY, GROUPBY, OR/NQ, keyword search,
 * related-list blocks) are supported, and the fields inside them are checked:
 * a related-list block's relation and inner conditions against its own table.
 * A `ref_<table>` cast passes only when the table hierarchy proves <table>
 * extends the reference target.
 *
 * Pure logic, no imports: the standalone bridge mirrors this file verbatim
 * (packages/snu/src/server/queryValidation.ts); the bridge parity test fails
 * when the copies differ. Both hosts run queryValidationVectors.ts.
 */

export type PathSource = 'query' | 'fields' | 'orderBy';
export type QueryProblemCode = 'E_INVALID_QUERY' | 'E_QUERY_UNVERIFIABLE';

/** Column metadata as `/api/now/ui/meta/<table>` returns it: `{ name: { type, reference } }`. */
export type Columns = Record<string, { type?: string; internal_type?: string; reference?: string } | undefined>;

/** Columns for a table, or null when they could not be read. */
export type SchemaLookup = (table: string) => Promise<Columns | null>;

/** The table a table extends ('' for a base table or an unknown name), or null when that could not be read. */
export type ParentLookup = (table: string) => Promise<string | null>;

export interface QueryProblem {
	code: QueryProblemCode;
	source: PathSource;
	/** The condition (or fields entry) as written. */
	condition: string;
	/** The field path, when one was recognised. */
	path?: string;
	/** The hop that failed and the table it was looked up on. */
	hop?: string;
	table?: string;
	reason: string;
}

interface ParsedCondition {
	source: PathSource;
	raw: string;
	/** The table the paths are relative to, when not the queried table (inside a related-list block). */
	table?: string;
	/** Field paths to check (the field, plus a field-valued operand). */
	paths: string[];
	/** Set when the field/operator boundary could not be recognised. */
	unrecognised?: string;
}

// Longest first, so ISNOTEMPTY is not read as ISNOT + EMPTY or IN as a prefix of INSTANCEOF.
const OPERATORS = [
	'GT_OR_EQUALS_FIELD', 'LT_OR_EQUALS_FIELD', 'NOT STARTSWITH', 'NOT ENDSWITH', 'EMPTYSTRING', 'INSTANCEOF',
	'ISNOTEMPTY', 'STARTSWITH', 'VALCHANGES', 'CHANGESFROM', 'RELATIVEGT', 'RELATIVELT', 'RELATIVEGE', 'RELATIVELE',
	'RELATIVEEE', 'ENDSWITH', 'NOT LIKE', 'ANYTHING', 'CHANGESTO', 'DATEPART', 'MORETHAN', 'LESSTHAN', 'GT_FIELD',
	'LT_FIELD', 'NSAMEAS', 'ISEMPTY', 'BETWEEN', 'DYNAMIC', 'NOTLIKE', 'NOT IN', 'SAMEAS', 'NOTON', 'NOTIN', 'LIKE',
	'!=', '>=', '<=', 'IN', 'ON', '=', '>', '<',
];
/** Operators whose value is another field on the same table. */
const FIELD_OPERANDS = new Set(['SAMEAS', 'NSAMEAS', 'GT_FIELD', 'LT_FIELD', 'GT_OR_EQUALS_FIELD', 'LT_OR_EQUALS_FIELD']);
const FIELD_PATH = /^[a-z0-9_]+(\.[a-z0-9_]+)*/;
const ESCAPED_CARET = '\u0000';

function isPath(text: string): boolean {
	const match = FIELD_PATH.exec(text);
	return !!match && match[0] === text;
}

function parseCondition(token: string, source: PathSource): ParsedCondition | null {
	let rest = token;
	if (rest === '' || rest === 'EQ') return null;
	if (rest.startsWith('NQ')) rest = rest.slice(2);
	const order = /^(ORDERBYDESC|ORDERBY|GROUPBY)(.*)$/.exec(rest);
	if (order) {
		return isPath(order[2])
			? { source, raw: token, paths: [order[2]] }
			: { source, raw: token, paths: [], unrecognised: `no field name after ${order[1]}` };
	}
	if (/^OR[a-z]/.test(rest)) rest = rest.slice(2);
	// Keyword search queries no column.
	if (/^(\d*TEXTQUERY\d*|IR_[A-Z_]*QUERY)/.test(rest)) return null;

	const field = FIELD_PATH.exec(rest);
	if (!field) return { source, raw: token, paths: [], unrecognised: 'no field name at the start of the condition' };
	const afterField = rest.slice(field[0].length);
	if (afterField === '' && source === 'orderBy') return { source, raw: token, paths: [field[0]] };
	const operator = OPERATORS.find((op) => afterField.startsWith(op));
	if (!operator) return { source, raw: token, paths: [], unrecognised: `unknown operator after "${field[0]}"` };
	const value = afterField.slice(operator.length);
	const paths = [field[0]];
	if (FIELD_OPERANDS.has(operator) && isPath(value)) paths.push(value);
	return { source, raw: token, paths };
}

/** Split an encoded query into its conditions. `^^` is a literal caret inside a value. */
export function parseEncodedQuery(query: string, source: PathSource = 'query'): ParsedCondition[] {
	if (typeof query !== 'string' || !query.trim()) return [];
	const conditions: ParsedCondition[] = [];
	// A related-list block, RLQUERY<table>.<field>,<op><n>[,m2m]^...^ENDRLQUERY,
	// filters on another table: its relation field and inner conditions are
	// checked against that table once ENDRLQUERY proves where the block ends.
	// Without that proof (never closed), or with a header that cannot be
	// read, the block is unverifiable as a whole.
	let related: { table: string | null; header: ParsedCondition; inner: ParsedCondition[] } | null = null;
	for (const raw of query.replace(/\^\^/g, ESCAPED_CARET).split('^')) {
		const token = raw.replace(new RegExp(ESCAPED_CARET, 'g'), '^').trim();
		if (token === 'ENDRLQUERY') {
			if (!related) conditions.push({ source, raw: token, paths: [], unrecognised: 'ENDRLQUERY without RLQUERY' });
			else conditions.push(related.header, ...related.inner);
			related = null;
			continue;
		}
		const header = /^(?:NQ)?RLQUERY(.*)$/.exec(token);
		if (header) {
			if (related) {
				conditions.push({ source, raw: token, paths: [], unrecognised: 'a related-list block inside another one' });
				continue;
			}
			const parts = /^([a-z0-9_]+)\.([a-z0-9_]+),[^^]*$/.exec(header[1]);
			related = parts
				? { table: parts[1], header: { source, raw: token, paths: [parts[2]], table: parts[1] }, inner: [] }
				: { table: null, header: { source, raw: token, paths: [], unrecognised: 'cannot read the related-list table and field' }, inner: [] };
			continue;
		}
		const condition = parseCondition(token, source);
		if (!condition) continue;
		if (related) {
			if (related.table !== null) related.inner.push({ ...condition, table: related.table });
		} else {
			conditions.push(condition);
		}
	}
	if (related) {
		conditions.push(related.table === null ? related.header
			: { source, raw: related.header.raw, paths: [], unrecognised: 'related-list block without ENDRLQUERY' });
	}
	return conditions;
}

/** Every condition of a query_records call: the query, the fields list and orderBy. */
export function collectConditions(params: { query?: unknown; fields?: unknown; orderBy?: unknown }): ParsedCondition[] {
	const conditions = parseEncodedQuery(typeof params.query === 'string' ? params.query : '', 'query');
	if (typeof params.fields === 'string') {
		for (const entry of params.fields.split(',').map((f) => f.trim()).filter(Boolean)) {
			conditions.push(isPath(entry)
				? { source: 'fields', raw: entry, paths: [entry] }
				: { source: 'fields', raw: entry, paths: [], unrecognised: 'not a field path' });
		}
	}
	if (typeof params.orderBy === 'string') conditions.push(...parseEncodedQuery(params.orderBy, 'orderBy'));
	return conditions;
}

type PathResult = null | { code: QueryProblemCode; reason: string; hop?: string; table?: string };

/**
 * Does `table` extend `ancestor`? Walks the parent chain. null when a link of
 * the chain could not be read, so the cast is unverifiable rather than invalid.
 */
async function extendsTable(table: string, ancestor: string, parentOf: ParentLookup): Promise<boolean | null> {
	let current = table;
	for (let depth = 0; depth < 16; depth++) {
		const parent = await parentOf(current);
		if (parent === null) return null;
		if (!parent) return false;
		if (parent === ancestor) return true;
		current = parent;
	}
	return null;
}

async function checkPath(table: string, path: string, lookup: SchemaLookup, parentOf: ParentLookup): Promise<PathResult> {
	const hops = path.split('.');
	let current = table;
	for (let i = 0; i < hops.length; i++) {
		const hop = hops[i];
		const columns = await lookup(current);
		if (!columns || Object.keys(columns).length === 0) {
			return { code: 'E_QUERY_UNVERIFIABLE', reason: `the columns of ${current} could not be read`, table: current };
		}
		const column = columns[hop];
		const last = i === hops.length - 1;
		if (!column) {
			// ref_<table> casts a reference to a table that extends its target.
			const cast = /^ref_([a-z0-9_]+)$/.exec(hop);
			if (cast && !last) {
				const proven = await extendsTable(cast[1], current, parentOf);
				if (proven === null) return { code: 'E_QUERY_UNVERIFIABLE', reason: `cannot tell whether ${cast[1]} extends ${current}`, table: current };
				if (!proven) return { code: 'E_INVALID_QUERY', reason: `${cast[1]} does not extend ${current}, so "${hop}" cannot cast it`, hop, table: current };
				current = cast[1];
				continue;
			}
			return { code: 'E_INVALID_QUERY', reason: `${current} has no field "${hop}"`, hop, table: current };
		}
		if (last) break;
		const reference = typeof column.reference === 'string' ? column.reference : '';
		if (!reference) {
			const type = String(column.internal_type || column.type || '');
			return type === 'reference'
				? { code: 'E_QUERY_UNVERIFIABLE', reason: `the target table of ${current}.${hop} is unknown`, table: current }
				: { code: 'E_INVALID_QUERY', reason: `${current}.${hop} is a ${type || 'non-reference'} field and cannot be dot-walked`, hop: hops[i + 1], table: current };
		}
		current = reference;
	}
	return null;
}

/**
 * Check every path of a query_records call. Returns the problems found; an
 * empty list means the query may run. A lookup that throws counts as data
 * that could not be read. Without parentOf every ref_ cast is unverifiable.
 */
export async function validateQuery(table: string, params: { query?: unknown; fields?: unknown; orderBy?: unknown }, lookup: SchemaLookup, parentOf: ParentLookup = async () => null): Promise<QueryProblem[]> {
	const safeLookup: SchemaLookup = async (t) => {
		try { return await lookup(t); } catch { return null; }
	};
	const safeParentOf: ParentLookup = async (t) => {
		try { return await parentOf(t); } catch { return null; }
	};
	const problems: QueryProblem[] = [];
	for (const condition of collectConditions(params)) {
		if (condition.unrecognised) {
			problems.push({ code: 'E_QUERY_UNVERIFIABLE', source: condition.source, condition: condition.raw, reason: condition.unrecognised });
			continue;
		}
		for (const path of condition.paths) {
			const result = await checkPath(condition.table || table, path, safeLookup, safeParentOf);
			if (result) problems.push({ code: result.code, source: condition.source, condition: condition.raw, path, ...(result.hop ? { hop: result.hop } : {}), ...(result.table ? { table: result.table } : {}), reason: result.reason });
		}
	}
	return problems;
}

/** The error to raise for a list of problems, or null when there are none. An invalid path outranks an unverifiable one. */
export function queryValidationError(problems: QueryProblem[]): { code: QueryProblemCode; message: string; details: { problems: QueryProblem[] } } | null {
	if (!problems.length) return null;
	const invalid = problems.find((p) => p.code === 'E_INVALID_QUERY');
	const first = invalid || problems[0];
	const where = `in "${first.condition}"${first.source === 'query' ? '' : ` (${first.source})`}`;
	const effect = first.source === 'fields' ? 'leave it out of the result' : 'ignore the condition and return unfiltered rows';
	const message = invalid
		? `Invalid query: ${first.reason} ${where}. ServiceNow would ${effect}, so the query was not run. Fix the path, or pass validate: false if the field exists but your session cannot see its definition.`
		: `The query could not be checked: ${first.reason} ${where}, so it was not run. Pass validate: false to run it unchecked.`;
	return { code: first.code, message, details: { problems } };
}

/**
 * Per-instance lookup cache for validateQuery (columns, or a table's parent).
 * Only answers that `keep` accepts are stored, for ttlMs; anything else is
 * asked again next time. Each call passes its own fetch, so a request's
 * correlation and session are used while the entries outlive it. `now` is
 * injected for the tests.
 */
export function createSchemaCache<T = Columns | null>(
	ttlMs = 10 * 60 * 1000,
	now: () => number = Date.now,
	keep: (value: T) => boolean = (value: any) => !!value && Object.keys(value).length > 0,
) {
	const entries = new Map<string, { value: T; at: number }>();
	return async (table: string, fetch: (table: string) => Promise<T>): Promise<T> => {
		const hit = entries.get(table);
		if (hit && now() - hit.at < ttlMs) return hit.value;
		const value = await fetch(table);
		if (keep(value)) entries.set(table, { value, at: now() });
		else entries.delete(table);
		return value;
	};
}

/** The super_class name out of a sys_db_object answer: '' for a base table or an unknown name, null when unreadable. */
export function parentFromDbObject(data: unknown): string | null {
	const rows = (data as any)?.result;
	if (!Array.isArray(rows)) return null;
	if (!rows.length) return '';
	const parent = rows[0]?.['super_class.name'];
	return typeof parent === 'string' ? parent : null;
}

/** The columns map out of a `/api/now/ui/meta/<table>` answer, or null. */
export function columnsFromMeta(data: unknown): Columns | null {
	const columns = (data as any)?.result?.columns;
	return columns && typeof columns === 'object' && !Array.isArray(columns) ? columns : null;
}
