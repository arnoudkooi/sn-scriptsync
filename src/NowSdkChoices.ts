// Choice lists are composite records: a wrapper contains a sys_choice_set
// record and multiple sys_choice records. v3 replaces the entire list; v4
// merges choices and carries explicit deletions. Keep that distinction when
// predicting whether a deploy would overwrite a platform edit.
import { xml2js, Element } from 'xml-js';

interface ChoiceSet {
	merge: boolean;
	fields: Map<string, string>;
	choices: Map<string, Map<string, string>>;
	selectors: Map<string, Map<string, string>>;
	deleted: Set<string>;
	deleteQueries: string[];
}

const HISTORY = new Set(['sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_created_on', 'sys_created_by', 'sys_update_name', 'sys_package', 'sys_scope', 'sys_policy', 'federated_id']);
const normalize = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
const children = (node: Element): Element[] => (node.elements || []).filter((e) => e.type === 'element');

export function isChoiceSet(xml: string): boolean {
	return /<record_update\b[^>]*>\s*<sys_choice(?:_set|_v2)?\b[^>]*\b(?:table|field)=/.test(xml)
		|| /<record_update\b[^>]*>\s*<sys_choice_(?:set|v2)\b/.test(xml);
}

function scalarFields(node: Element, raw: boolean, includeHistory = false): Map<string, string> {
	const fields = new Map<string, string>();
	for (const child of children(node)) {
		if (!child.name || (!includeHistory && HISTORY.has(child.name)) || children(child).length) continue;
		const value = (child.elements || []).map((e) => e.type === 'text' ? String(e.text ?? '') : e.type === 'cdata' ? String(e.cdata ?? '') : '').join('');
		fields.set(child.name, raw ? value : normalize(value));
	}
	return fields;
}

function parseChoiceSet(xml: string, raw = false): ChoiceSet {
	const doc = xml2js(xml, { compact: false, ignoreComment: true }) as Element;
	const update = children(doc).find((e) => e.name === 'record_update');
	const wrapper = update && children(update).find((e) => ['sys_choice', 'sys_choice_set', 'sys_choice_v2'].includes(e.name || ''));
	if (!wrapper) throw new Error('Could not read the choice list in the app package.');
	const header = children(wrapper).find((e) => e.name === 'sys_choice_set') || wrapper;
	const fields = scalarFields(header, raw);
	const result: ChoiceSet = { merge: wrapper.name === 'sys_choice_v2', fields, choices: new Map(), selectors: new Map(), deleted: new Set(), deleteQueries: [] };
	for (const node of children(wrapper).filter((e) => e.name === 'sys_choice')) {
		const action = String(node.attributes?.action || 'INSERT_OR_UPDATE').toUpperCase();
		if (action === 'DELETE_MULTIPLE') {
			result.deleteQueries.push(String(node.attributes?.query || ''));
			continue;
		}
		const choice = scalarFields(node, raw);
		// Choice IDs may be re-created by an install. The SDK coalesces by
		// these five fields, including language and dependent value.
		choice.delete('sys_id');
		choice.delete('sys_class_name');
		for (const [field, fallback] of [['name', fields.get('name') || String(wrapper.attributes?.table || '')], ['element', fields.get('element') || String(wrapper.attributes?.field || '')], ['value', ''], ['language', ''], ['dependent_value', ''], ['inactive', 'false'], ['inactive_on_update', 'false']]) {
			if (!choice.get(field)) choice.set(field, fallback);
		}
		const key = JSON.stringify(['name', 'element', 'value', 'language', 'dependent_value'].map((f) => normalize(choice.get(f) || '')));
		if (action === 'DELETE') {
			result.deleted.add(key);
			continue;
		}
		if (result.choices.has(key)) throw new Error(`The app package has duplicate choices for ${key}.`);
		result.choices.set(key, choice);
		// Deletion queries can match IDs and history even though those fields
		// must not appear as changes in the comparison.
		result.selectors.set(key, new Map([...choice, ...scalarFields(node, false, true)]));
	}
	return result;
}

/** Stable, readable entries: XML order, empty fields and record history do not create changes. */
export function choiceSetFields(xml: string, raw = false): Map<string, string> {
	const set = parseChoiceSet(xml, raw);
	const entries = [...set.choices].sort(([a], [b]) => a.localeCompare(b)).map(([, choice]) =>
		Object.fromEntries([...choice].filter(([, v]) => v !== '').sort(([a], [b]) => a.localeCompare(b))));
	set.fields.set('choices', JSON.stringify(entries, null, 2));
	return set.fields;
}

function matchesDeletion(query: string, choice: Map<string, string>): boolean {
	// SDK v4 emits equality clauses joined by ^ and ^NQ. Unknown query
	// syntax is treated conservatively so a deploy cannot silently erase a
	// change merely because we cannot predict its deletion selector.
	return query.split('^NQ').some((group) => group.split('^').every((term) => {
		const match = /^([a-z_][a-z0-9_]*)=(.*)$/i.exec(term);
		return !match || !choice.has(match[1]) || choice.get(match[1]) === match[2];
	}));
}

/** Compare each changed choice field with what this package would install. */
export function choicesWouldBeOverwritten(beforeXml: string | undefined, instanceXml: string | undefined, builtXml: string): boolean {
	const before = beforeXml ? parseChoiceSet(beforeXml).choices : new Map<string, Map<string, string>>();
	const instance = instanceXml ? parseChoiceSet(instanceXml) : undefined;
	const now = instance?.choices || new Map<string, Map<string, string>>();
	const build = parseChoiceSet(builtXml);
	for (const key of new Set([...before.keys(), ...now.keys()])) {
		const was = before.get(key), current = now.get(key);
		let next = build.choices.get(key);
		if (build.merge && !next && current && !build.deleted.has(key) && !build.deleteQueries.some((q) => matchesDeletion(q, instance!.selectors.get(key)!))) next = current;
		if (!current) {
			if (was && next) return true; // the deploy re-creates a deleted choice
			continue;
		}
		const fields = new Set([...(was?.keys() || []), ...current.keys()]);
		const changed = [...fields].filter((f) => (was?.get(f) ?? '') !== (current.get(f) ?? ''));
		if ((!was || changed.length) && (!next || changed.some((f) => (current.get(f) ?? '') !== (next!.get(f) ?? '')))) return true;
	}
	return false;
}
