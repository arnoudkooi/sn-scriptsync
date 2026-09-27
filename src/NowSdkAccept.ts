// "Accept instance change": bring a change someone made on the instance into
// the project, whatever kind of record it is. Per changed field:
//  - pull:     a record the SDK converts back (the SDK's own pull does it);
//  - override: a field the build does not carry (the Fluent API has no
//              property for it), accepted through `$override` on the record's
//              Fluent definition;
//  - patch:    content generated from a source file (a UI page built from
//              src/client, a server module from src/server, ...): the changed
//              lines are applied to the one source file that holds that text;
//  - otherwise the field is reported as not acceptable automatically.
//
// Kept free of `vscode` imports; this only plans the edits, the caller applies
// them so they show up as normal, undoable editor changes.

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { InstanceChange, listProjectFiles, readKeyNames, readRecordFields } from './NowSdkPull';

export interface AcceptEdit {
	/** Project-relative path. */
	file: string;
	content: string;
	/** What was accepted, e.g. "UI Page Todo Board: html". */
	what: string;
}

export interface AcceptPlan {
	edits: AcceptEdit[];
	/** Fields the SDK's pull brings in. */
	pullFields: string[];
	/** Fields that could not be accepted automatically, with why. */
	unresolved: Array<{ field: string; why: string }>;
	/** Fields placed into the source by an edit; a build should now produce the instance value. */
	edited: string[];
}

const TEXT_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|html|htm|css|scss|json|xml|txt|md)$/i;
const CONTEXT_LINES = 2;

/** Source files an edit may land in: the project's own text files, not generated bookkeeping. */
function sourceFiles(root: string): string[] {
	return listProjectFiles(root).filter((f) => TEXT_FILE.test(f) && !f.endsWith('generated/keys.ts') && f !== 'package-lock.json');
}

interface Line {
	text: string;
	key: string;
}

/** Lines that carry content, compared without surrounding whitespace (so CRLF, indentation and blank lines do not count). */
function meaningfulLines(text: string): Line[] {
	return text.replace(/\r\n?/g, '\n').split('\n').map((text) => ({ text, key: text.trim() })).filter((l) => l.key.length > 0);
}

interface Hunk {
	before: string[];
	removed: string[];
	added: Line[];
	after: string[];
}

/** Line hunks between two texts (longest common subsequence on meaningful lines). */
function lineHunks(base: string, theirs: string): Hunk[] {
	const a = meaningfulLines(base), b = meaningfulLines(theirs);
	let start = 0;
	while (start < a.length && start < b.length && a[start].key === b[start].key) start++;
	let endA = a.length, endB = b.length;
	while (endA > start && endB > start && a[endA - 1].key === b[endB - 1].key) { endA--; endB--; }
	const midA = a.slice(start, endA), midB = b.slice(start, endB);
	const n = midA.length, m = midB.length;
	// Pairs of equal lines in the changed middle; plain LCS, or one hunk when it is too large.
	const pairs: Array<[number, number]> = [];
	if (n > 0 && m > 0 && n * m <= 4_000_000) {
		const dp = new Uint32Array((n + 1) * (m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i * (m + 1) + j] = midA[i].key === midB[j].key ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
			}
		}
		for (let i = 0, j = 0; i < n && j < m;) {
			if (midA[i].key === midB[j].key) { pairs.push([i, j]); i++; j++; }
			else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++;
			else j++;
		}
	}
	pairs.push([n, m]);
	const hunks: Hunk[] = [];
	let pi = 0, pj = 0;
	for (const [i, j] of pairs) {
		if (i > pi || j > pj) {
			const absA = start + pi, absEndA = start + i;
			hunks.push({
				before: a.slice(Math.max(0, absA - CONTEXT_LINES), absA).map((l) => l.key),
				removed: a.slice(absA, absEndA).map((l) => l.key),
				added: b.slice(start + pj, start + j),
				after: a.slice(absEndA, absEndA + CONTEXT_LINES).map((l) => l.key),
			});
		}
		pi = i + 1;
		pj = j + 1;
	}
	return hunks;
}

/** Place one hunk in exactly one file, trying less context when the surrounding lines differ. */
function applyHunk(files: Map<string, string>, hunk: Hunk): { file: string; content: string } | null {
	for (let context = CONTEXT_LINES; context >= 0; context--) {
		const before = hunk.before.slice(hunk.before.length - context);
		const after = hunk.after.slice(0, context);
		const needle = [...before, ...hunk.removed, ...after];
		// Without anything to anchor on, the place would be a guess.
		if (needle.filter((l) => l.length > 2).length === 0) continue;
		const hits: Array<{ file: string; lines: string[]; at: number[] }> = [];
		for (const [file, text] of files) {
			const lines = text.replace(/\r\n?/g, '\n').split('\n');
			const positions: number[] = [];
			lines.forEach((l, i) => { if (l.trim()) positions.push(i); });
			for (let i = 0; i + needle.length <= positions.length && hits.length < 2; i++) {
				let ok = true;
				for (let j = 0; j < needle.length; j++) {
					if (lines[positions[i + j]].trim() !== needle[j]) { ok = false; break; }
				}
				if (ok) hits.push({ file, lines, at: positions.slice(i, i + needle.length) });
			}
			if (hits.length > 1) break;
		}
		if (hits.length > 1) return null; // ambiguous; less context only gets worse
		if (hits.length === 0) continue;
		const { file, lines, at } = hits[0];
		let from: number, to: number;
		if (hunk.removed.length > 0) {
			from = at[before.length];
			to = at[before.length + hunk.removed.length - 1] + 1;
		} else {
			from = before.length ? at[before.length - 1] + 1 : at[0];
			to = from;
		}
		// The new lines take the indentation the file uses at that spot.
		const fileIndent = (lines[from] ?? lines[Math.max(0, from - 1)] ?? '').match(/^\s*/)![0];
		const theirIndent = hunk.added[0]?.text.match(/^\s*/)![0] ?? '';
		const added = hunk.added.map((l) => (l.text.startsWith(theirIndent) ? fileIndent + l.text.slice(theirIndent.length) : l.text).replace(/\r$/, ''));
		return { file, content: [...lines.slice(0, from), ...added, ...lines.slice(to)].join('\n') };
	}
	return null;
}

/**
 * Apply the change from `base` to `theirs` to the source files that hold the
 * base text. Each changed region is located in the source with a little
 * unchanged context (less when that context differs, as build output is often
 * formatted differently); lines match ignoring surrounding whitespace, line
 * endings and blank lines, and the new lines take the file's indentation.
 * Returns null unless every region lands in exactly one place.
 */
export function patchIntoSource(files: Map<string, string>, base: string, theirs: string): { file: string; content: string } | null {
	const hunks = lineHunks(base, theirs);
	if (hunks.length === 0) return null;
	const current = new Map(files);
	let last: { file: string; content: string } | null = null;
	const touched = new Set<string>();
	for (const hunk of hunks) {
		const res = applyHunk(current, hunk);
		if (!res) return null;
		current.set(res.file, res.content);
		touched.add(res.file);
		last = res;
	}
	// One field's change is expected to land in one file.
	if (touched.size !== 1 || !last) return null;
	return { file: last.file, content: current.get(last.file)! };
}

function literal(value: string): string {
	if (value === 'true' || value === 'false') return value;
	if (/^-?\d+(\.\d+)?$/.test(value) && value.length < 16) return value;
	return JSON.stringify(value);
}

/**
 * The TypeScript compiler from the project (the ServiceNow SDK depends on it),
 * else the one next to this extension; null when neither is there.
 */
export function loadTypeScript(projectRoot: string): typeof import('typescript') | null {
	for (const from of [path.join(projectRoot, 'package.json'), __filename]) {
		try {
			return createRequire(from)('typescript');
		} catch {}
	}
	return null;
}

function propertyName(ts: typeof import('typescript'), prop: import('typescript').ObjectLiteralElementLike): string | undefined {
	const name = prop.name;
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
	return undefined;
}

/**
 * Add `field: value` to the `$override` of the Fluent definition with this
 * Now.ID name, creating `$override` when it is not there yet. Reads the file
 * with the TypeScript parser, so strings, comments and nesting cannot throw
 * it off; only the text of the one property changes.
 */
export function addOverride(files: Map<string, string>, keyName: string, field: string, value: string, ts = loadTypeScript(process.cwd())): { file: string; content: string } | null {
	if (!ts) return null;
	const entry = `${/^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field)}: ${literal(value)}`;
	for (const [file, text] of files) {
		if (!file.endsWith('.now.ts') || !text.includes(keyName)) continue;
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		let definition: import('typescript').ObjectLiteralExpression | undefined;
		const visit = (node: import('typescript').Node) => {
			if (definition) return;
			if (ts.isObjectLiteralExpression(node)) {
				const id = node.properties.find((p) => propertyName(ts, p) === '$id');
				const init = id && ts.isPropertyAssignment(id) ? id.initializer : undefined;
				if (init && ts.isElementAccessExpression(init) && init.expression.getText(source) === 'Now.ID'
					&& ts.isStringLiteralLike(init.argumentExpression) && init.argumentExpression.text === keyName) {
					definition = node;
					return;
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		if (!definition) continue;

		const override = definition.properties.find((p) => propertyName(ts, p) === '$override');
		if (override) {
			// Only an object written out in place can be extended safely.
			if (!ts.isPropertyAssignment(override) || !ts.isObjectLiteralExpression(override.initializer)) return null;
			const obj = override.initializer;
			const existing = obj.properties.find((p) => propertyName(ts, p) === field);
			if (existing) {
				if (!ts.isPropertyAssignment(existing)) return null;
				const at = existing.getStart(source);
				return { file, content: text.slice(0, at) + entry + text.slice(existing.end) };
			}
			const brace = obj.getStart(source) + 1;
			const content = obj.properties.length
				? text.slice(0, brace) + ` ${entry},` + text.slice(brace)
				: text.slice(0, brace) + ` ${entry} ` + text.slice(obj.end - 1);
			return { file, content };
		}

		const id = definition.properties.find((p) => propertyName(ts, p) === '$id')!;
		const lineStart = text.lastIndexOf('\n', id.getStart(source)) + 1;
		const indent = text.slice(lineStart, id.getStart(source)).match(/^\s*/)![0];
		const hasComma = text.slice(id.end).match(/^\s*,/);
		if (hasComma) {
			const at = id.end + hasComma[0].length;
			return { file, content: text.slice(0, at) + `\n${indent}$override: { ${entry} },` + text.slice(at) };
		}
		return { file, content: text.slice(0, id.end) + `,\n${indent}$override: { ${entry} }` + text.slice(id.end) };
	}
	return null;
}

/**
 * Plan how to accept one instance change. `baseXml` is the record after the
 * last sync, `instanceXml` the record now, `builtXml` the record in the last
 * build (undefined when not built or not in the build).
 */
export function planAccept(
	projectRoot: string,
	change: InstanceChange,
	baseXml: string | undefined,
	instanceXml: string | undefined,
	builtXml: string | undefined,
	opts: { openFiles?: Map<string, string> } = {},
): AcceptPlan {
	const plan: AcceptPlan = { edits: [], pullFields: [], unresolved: [], edited: [] };
	if (!instanceXml) {
		plan.unresolved.push({ field: '(record)', why: 'it was deleted on the instance; remove its definition from your source to accept that' });
		return plan;
	}
	const base = baseXml ? readRecordFields(baseXml) : new Map<string, string>();
	const now = readRecordFields(instanceXml);
	const built = builtXml ? readRecordFields(builtXml) : null;
	const changed = [...new Set([...base.keys(), ...now.keys()])].filter((k) => (base.get(k) ?? '').trim() !== (now.get(k) ?? '').trim());

	const files = new Map<string, string>();
	for (const f of sourceFiles(projectRoot)) {
		try { files.set(f, fs.readFileSync(path.join(projectRoot, f), 'utf8')); } catch {}
	}
	// Files open in the editor are planned against what is there, saved or not.
	for (const [f, text] of opts.openFiles || []) if (files.has(f)) files.set(f, text);
	let ts: ReturnType<typeof loadTypeScript> | undefined;
	const sysId = now.get('sys_id') || '';
	const keyName = readKeyNames(projectRoot).get(sysId);
	const label = change.label;
	const edited = new Map<string, string>(); // file -> content, so several fields can land in one file

	for (const field of changed) {
		const value = now.get(field) ?? '';
		const current = new Map(files);
		for (const [f, c] of edited) current.set(f, c);

		// A field the build does not carry: the Fluent API has no property for it.
		if (built && !built.has(field) && !change.generated) {
			if (!keyName) {
				plan.unresolved.push({ field, why: 'the record has no Fluent definition with an $id in your source yet; pull it first' });
				continue;
			}
			if (ts === undefined) ts = loadTypeScript(projectRoot);
			if (!ts) {
				plan.unresolved.push({ field, why: 'the TypeScript compiler was not found in the project; run npm install' });
				continue;
			}
			const res = addOverride(current, keyName, field, value, ts);
			if (res) {
				edited.set(res.file, res.content);
				plan.edits.push({ file: res.file, content: res.content, what: `${label}: ${field} (as $override)` });
				plan.edited.push(field);
			} else {
				plan.unresolved.push({ field, why: `no definition with $id Now.ID['${keyName}'] and an $override written out in place found in a .now.ts file` });
			}
			continue;
		}
		// A record the SDK converts back: its own pull does it right.
		if (!change.generated) {
			plan.pullFields.push(field);
			continue;
		}
		// Generated content: patch the source it comes from.
		const res = baseXml ? patchIntoSource(current, base.get(field) ?? '', value) : null;
		if (res) {
			edited.set(res.file, res.content);
			plan.edits.push({ file: res.file, content: res.content, what: `${label}: ${field}` });
			plan.edited.push(field);
		} else {
			plan.unresolved.push({ field, why: `${change.reason || 'generated from your source'}, and the changed text was not found in exactly one source file` });
		}
	}
	// One edit per file, with the final content.
	const byFile = new Map<string, AcceptEdit>();
	for (const e of plan.edits) {
		const prev = byFile.get(e.file);
		byFile.set(e.file, { file: e.file, content: edited.get(e.file)!, what: prev ? `${prev.what}, ${e.what.split(': ').pop()}` : e.what });
	}
	plan.edits = [...byFile.values()];
	return plan;
}
