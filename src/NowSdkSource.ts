import * as path from 'path';
import { createRequire } from 'module';
import type * as TS from 'typescript';

/** Use the project's compiler (also required by the SDK), then our own. */
export function loadTypeScript(projectRoot: string): typeof TS | null {
	for (const from of [path.join(projectRoot, 'package.json'), __filename]) {
		try { return createRequire(from)('typescript'); } catch {}
	}
	return null;
}

/** Table and ChoiceSet definitions often have no Now.ID to match by. */
export function disabledChoiceTables(projectRoot: string, file: string, text: string): Set<string> {
	const result = new Set<string>();
	if (!text.includes('@fluent-disable-sync')) return result;
	const ts = loadTypeScript(projectRoot);
	// Without a parser we cannot safely claim the SDK can convert these lists.
	if (!ts) return new Set(['*']);
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const aliases = new Map([['Table', 'Table'], ['ChoiceSet', 'ChoiceSet']]);
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings)) {
			for (const spec of bindings.elements) {
				const original = (spec.propertyName || spec.name).text;
				if (original === 'Table' || original === 'ChoiceSet') aliases.set(spec.name.text, original);
			}
		}
	}
	const directive = (node: TS.Node) => (ts.getLeadingCommentRanges(text, node.getFullStart()) || [])
		.some((c) => /@fluent-disable-sync\b/.test(text.slice(c.pos, c.end)));
	const containsDirective = (node: TS.Node): boolean => directive(node) || !!ts.forEachChild(node, (child) => containsDirective(child) || undefined);
	const wholeFile = /@fluent-disable-sync-for-file\b/.test(text);
	const visit = (node: TS.Node) => {
		if (ts.isCallExpression(node)) {
			const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
			if (aliases.has(name)) {
				let disabled = wholeFile || containsDirective(node);
				for (let parent: TS.Node | undefined = node.parent; parent && parent !== source; parent = parent.parent) disabled ||= directive(parent);
				if (disabled) {
					const obj = node.arguments[0];
					const literal = (key: string) => {
						const prop = obj && ts.isObjectLiteralExpression(obj) && obj.properties.find((p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key);
						return prop && ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : undefined;
					};
					const choiceSet = aliases.get(name) === 'ChoiceSet';
					const table = literal(choiceSet ? 'table' : 'name');
					const field = choiceSet && literal('field');
					result.add(table ? `${table}${field ? '.' + field : ''}` : '*');
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return result;
}
