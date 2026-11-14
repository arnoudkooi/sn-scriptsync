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
