// Which instance record a Fluent definition in the source stands for, so the
// editor can open it on the instance, compare it, or accept a change to it
// from the definition itself. The SDK keeps the mapping in
// src/fluent/generated/keys.ts: `explicit` entries by Now.ID name, and
// `composite` entries for records it matches on fields (a table by name, a
// column by table and element, a UI page by endpoint, a role by name).
//
// Kept free of `vscode` imports; the TypeScript compiler is passed in (see
// loadTypeScript in NowSdkAccept.ts).

import * as fs from 'fs';
import * as path from 'path';
import type * as TS from 'typescript';
import { listProjectFiles } from './NowSdkPull';

export interface KeyEntry {
	table: string;
	id: string;
}

export interface KeysFile {
	explicit: Map<string, KeyEntry>;
	composite: Array<KeyEntry & { key: Record<string, string> }>;
}

export interface SourceRecord extends KeyEntry {
	/** "Role x_app.user", "Column due", ... */
	label: string;
	/** Offsets of the definition in the file. */
	start: number;
	end: number;
}

/** Parse keys.ts. Deleted entries are left out. */
export function parseKeysFile(text: string): KeysFile {
	const explicit = new Map<string, KeyEntry>();
	const composite: KeysFile['composite'] = [];
	const explicitRe = /['"]?([\w.$-]+)['"]?\s*:\s*\{\s*table:\s*'([^']+)'\s*id:\s*'([0-9a-f]{32})'\s*(deleted:\s*true\s*)?\}/g;
	let m: RegExpExecArray | null;
	while ((m = explicitRe.exec(text))) {
		if (!m[4]) explicit.set(m[1], { table: m[2], id: m[3] });
	}
	const compositeRe = /\{\s*table:\s*'([^']+)'\s*id:\s*'([0-9a-f]{32})'\s*key:\s*\{([^}]*)\}\s*(deleted:\s*true\s*)?\}/g;
	while ((m = compositeRe.exec(text))) {
		if (m[4]) continue;
		const key: Record<string, string> = {};
		const fieldRe = /['"]?([\w$]+)['"]?\s*:\s*'((?:[^'\\]|\\.)*)'/g;
		let f: RegExpExecArray | null;
		while ((f = fieldRe.exec(m[3]))) key[f[1]] = f[2].replace(/\\(.)/g, '$1');
		composite.push({ table: m[1], id: m[2], key });
	}
	return { explicit, composite };
}

export function readKeysFile(projectRoot: string): KeysFile {
	const file = listProjectFiles(projectRoot).find((f) => f.endsWith('generated/keys.ts'));
	if (!file) return { explicit: new Map(), composite: [] };
	try {
		return parseKeysFile(fs.readFileSync(path.join(projectRoot, file), 'utf8'));
	} catch {
		return { explicit: new Map(), composite: [] };
	}
}

/** The table a Fluent API call usually creates, to choose between matching composite keys. */
const CALL_TABLES: Record<string, string> = {
	Table: 'sys_db_object',
	Role: 'sys_user_role',
	UiPage: 'sys_ui_page',
	Acl: 'sys_security_acl',
	BusinessRule: 'sys_script',
	ScriptInclude: 'sys_script_include',
	ClientScript: 'sys_script_client',
	UiAction: 'sys_ui_action',
	Property: 'sys_properties',
	ApplicationMenu: 'sys_app_application',
	Record: '',
};

function propName(ts: typeof TS, prop: TS.ObjectLiteralElementLike): string | undefined {
	const name = prop.name;
	if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) return name.text;
	return undefined;
}

/** String and boolean-ish literal properties of an object, as the platform would store them. */
function literalProps(ts: typeof TS, obj: TS.ObjectLiteralExpression): Record<string, string> {
	const props: Record<string, string> = {};
	for (const p of obj.properties) {
		const name = propName(ts, p);
		if (!name || !ts.isPropertyAssignment(p)) continue;
		const v = p.initializer;
		if (ts.isStringLiteralLike(v)) props[name] = v.text;
		else if (ts.isNumericLiteral(v)) props[name] = v.text;
		else if (v.kind === ts.SyntaxKind.TrueKeyword) props[name] = 'true';
		else if (v.kind === ts.SyntaxKind.FalseKeyword) props[name] = 'false';
	}
	return props;
}

function calleeName(ts: typeof TS, call: TS.CallExpression): string {
	const e = call.expression;
	if (ts.isIdentifier(e)) return e.text;
	if (ts.isPropertyAccessExpression(e)) return e.name.text;
	return '';
}

function byId(keys: KeysFile, id: string): KeyEntry | undefined {
	for (const entry of keys.explicit.values()) if (entry.id === id) return entry;
	return keys.composite.find((c) => c.id === id);
}

function matchComposite(keys: KeysFile, props: Record<string, string>, preferTable?: string): KeyEntry | undefined {
	const matches = keys.composite.filter((c) => {
		const fields = Object.entries(c.key);
		return fields.length > 0 && fields.every(([k, v]) => props[k] === v);
	});
	if (preferTable) {
		const preferred = matches.filter((c) => c.table === preferTable);
		if (preferred.length === 1) return preferred[0];
	}
	return matches.length === 1 ? matches[0] : undefined;
}

/** Every definition in a Fluent file that maps to an instance record. */
export function recordsInSource(ts: typeof TS, fileName: string, text: string, keys: KeysFile): SourceRecord[] {
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const out: SourceRecord[] = [];
	const visit = (node: TS.Node) => {
		if (ts.isCallExpression(node) && node.arguments.length && ts.isObjectLiteralExpression(node.arguments[0])) {
			const call = calleeName(ts, node);
			const obj = node.arguments[0];
			const props = literalProps(ts, obj);
			let entry: KeyEntry | undefined;
			const idProp = obj.properties.find((p) => propName(ts, p) === '$id');
			const idInit = idProp && ts.isPropertyAssignment(idProp) ? idProp.initializer : undefined;
			let idName: string | undefined;
			if (idInit && ts.isElementAccessExpression(idInit) && ts.isStringLiteralLike(idInit.argumentExpression)) {
				idName = idInit.argumentExpression.text;
				entry = keys.explicit.get(idName);
			} else if (idInit && ts.isStringLiteralLike(idInit) && /^[0-9a-f]{32}$/.test(idInit.text)) {
				entry = byId(keys, idInit.text);
			}
			// Records the SDK matches on fields are kept as composite keys instead.
			if (!entry && /^[A-Z]/.test(call)) entry = matchComposite(keys, props, CALL_TABLES[call]);
			if (entry) {
				const name = props.name || props.endpoint || props.label || props.title || idName || '';
				out.push({ ...entry, label: name ? `${call} ${name}` : call, start: node.getStart(source), end: node.end });
			}
			// The columns of a table are sys_dictionary records keyed by table and element.
			if (call === 'Table' && props.name) {
				const schema = obj.properties.find((p) => propName(ts, p) === 'schema');
				if (schema && ts.isPropertyAssignment(schema) && ts.isObjectLiteralExpression(schema.initializer)) {
					for (const column of schema.initializer.properties) {
						const element = propName(ts, column);
						if (!element) continue;
						const col = keys.composite.find((c) => c.table === 'sys_dictionary' && c.key.name === props.name && c.key.element === element);
						if (col) out.push({ table: col.table, id: col.id, label: `Column ${props.name}.${element}`, start: column.getStart(source), end: column.end });
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

/** The innermost definition around `offset`, if any. */
export function recordAtOffset(records: SourceRecord[], offset: number): SourceRecord | undefined {
	return records
		.filter((r) => r.start <= offset && offset <= r.end)
		.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}

/** The file name a record has in an app package (and in the baseline). */
export function recordFileName(r: KeyEntry): string {
	return `${r.table}_${r.id}.xml`;
}

export interface SourceLocation {
	/** Project-relative path. */
	file: string;
	/** Offset of the definition; 0 for a whole file. */
	start: number;
}

/**
 * Where each record of the app is defined in the source, by sys_id: the
 * Fluent definition in a .now.ts file, or for a server module (sys_module)
 * the source file itself, which keys.ts names after its path.
 */
export function indexSourceDefinitions(ts: typeof TS, projectRoot: string, keys = readKeysFile(projectRoot)): Map<string, SourceLocation> {
	const index = new Map<string, SourceLocation>();
	const files = listProjectFiles(projectRoot).filter((f) => !f.startsWith('dist/') && !f.startsWith('.snu/'));
	for (const file of files.filter((f) => f.endsWith('.now.ts'))) {
		let text: string;
		try {
			text = fs.readFileSync(path.join(projectRoot, file), 'utf8');
		} catch {
			continue;
		}
		for (const r of recordsInSource(ts, file, text, keys)) {
			if (!index.has(r.id)) index.set(r.id, { file, start: r.start });
		}
	}
	const byKeyName = new Map(files.map((f) => [f.replace(/[/.]/g, '_'), f]));
	for (const [name, entry] of keys.explicit) {
		const file = entry.table === 'sys_module' ? byKeyName.get(name) : undefined;
		if (file && !index.has(entry.id)) index.set(entry.id, { file, start: 0 });
	}
	return index;
}
