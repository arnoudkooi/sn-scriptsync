// Result shaping shared by the agent commands. Mirrors compactSearchResults and
// queryCoverage in packages/snu/src/server/dispatcher.ts: both hosts must
// answer alike (scripts/test-bridge-parity.mjs).

/** Table, match count and record names only: the full hits carry every
 * matching line and run to hundreds of kilobytes for a common term. */
export function compactSearchResults(results: any): Array<{ table: string; label?: string; count: number; names: string[] }> {
	if (!Array.isArray(results)) return [];
	return results.map((t: any) => {
		const hits: any[] = Array.isArray(t?.hits) ? t.hits : [];
		const count = Number(t?.rowCount);
		return {
			table: String(t?.tableName ?? t?.table ?? ''),
			...(t?.tableLabel ?? t?.label ? { label: String(t.tableLabel ?? t.label) } : {}),
			count: Number.isFinite(count) && count > 0 ? count : hits.length,
			names: hits.map((h) => String(h?.name ?? h?.sysId ?? h?.sys_id ?? '')),
		};
	});
}

/** What a query result leaves out, so a caller never mistakes the first page
 * or the default projection for everything. `total` is the instance's own
 * count when it reported one. */
export function queryCoverage(count: number, limit: unknown, totalHeader: unknown, defaultFields: boolean, defaultLimit: boolean): Record<string, any> {
	const max = Number(limit);
	const total = typeof totalHeader === 'string' && /^\d+$/.test(totalHeader) ? Number(totalHeader) : undefined;
	const more = total !== undefined ? total > count : Number.isFinite(max) && max > 0 && count >= max;
	const notes: string[] = [];
	if (more) notes.push(total !== undefined
		? `Showing ${count} of ${total} matching records; raise "limit" to read more.`
		: `The limit of ${max} was reached, so more records may match; raise "limit" to read more.`);
	if (defaultFields && count > 0) notes.push('Only the default fields were returned; pass "fields" to choose them.');
	return {
		...(Number.isFinite(max) ? { limit: max } : {}),
		...(total !== undefined ? { total } : {}),
		more,
		...(defaultLimit ? { defaultLimit: true } : {}),
		...(defaultFields ? { defaultFields: true } : {}),
		...(notes.length ? { note: notes.join(' ') } : {}),
	};
}

/** Encoded query for the Aggregate API count: ordering is irrelevant there. */
export function countQuery(query: string): string {
	return query.replace(/\^ORDERBY(?:DESC)?[^^]*/g, '');
}

export type ScopeOutcome = 'complete' | 'partial' | 'failed' | 'empty';

/** Adds `outcome` (and a note when it is not complete) to a pull_scope report.
 * failed: nothing could be pulled because the dictionary could not be read for
 * the tables in question. empty: nothing to pull, and that is established.
 * Mirrors packages/snu/src/server/dispatcher.ts. */
export function finishScopeReport<T extends { complete: boolean; metadataRecords: number; tables: any[]; skippedTables: Array<{ table: string; reason: string }> }>(report: T, tableFilter?: Set<string> | null, discoveryComplete = true): T & { outcome: ScopeOutcome; note?: string } {
	const failedTables = report.skippedTables.filter(t => t.reason === 'dictionary_unavailable' && (!tableFilter || tableFilter.has(t.table)));
	// Empty is a claim about the scope, so it needs a complete record list: with
	// records missing from it, a table with scripts may be among them.
	const outcome: ScopeOutcome = report.tables.length === 0
		? (failedTables.length || !discoveryComplete ? 'failed' : 'empty')
		: report.complete ? 'complete' : 'partial';
	const note = outcome === 'partial'
		? `Some records were not pulled or could not be verified${failedTables.length ? `; ${failedTables.length} table(s) were skipped because their dictionary could not be read` : ''}. See skippedTables and warnings.`
		: outcome === 'empty' ? 'Nothing to pull: the scope has no records in tables with script fields.' : undefined;
	return { ...report, outcome, ...(note ? { note } : {}) };
}

/** Error text for a pull_scope that could not pull anything. */
export function scopeFailureMessage(report: { metadataRecords: number; scope?: { name?: string }; skippedTables: Array<{ reason: string }>; warnings: string[] }): string {
	const failed = report.skippedTables.filter(t => t.reason === 'dictionary_unavailable').length;
	const first = report.warnings.find(w => /dictionary|inheritance|pagination|not returned|stopped after/i.test(w)) || report.warnings[0];
	const why = failed
		? `the instance dictionary could not be read for ${failed} of ${report.skippedTables.length} table(s) with records (${report.metadataRecords} metadata records found).`
		: `the list of its records could not be read completely (${report.metadataRecords} metadata records found), so it cannot be called empty.`;
	return `Nothing was pulled from scope ${report.scope?.name ?? ''}: ${why}`
		+ (first ? ` First problem: ${first}` : '')
		+ ' Details list every table and warning. Pull single tables with pull_records meanwhile.';
}
