import test from 'node:test';
import assert from 'node:assert';
import { analyzeArtifactType, profileStillFresh, profileFileName, validateProfileParams, currentFingerprint, shiftTime, ProfileIO, ANALYZER_VERSION } from '../agent/artifactProfile';

// A small fake instance: tables of flat rows (dot-walked fields stored as
// flat keys) and an encoded-query evaluator covering what the engine uses.
type Row = Record<string, any>;
function matches(row: Row, term: string): boolean {
	const ops = ['!=', '>=', '<=', 'NOT LIKE', 'STARTSWITH', 'ISNOTEMPTY', 'ISEMPTY', 'LIKE', 'IN', '='];
	for (const op of ops) {
		const i = term.indexOf(op);
		if (i <= 0) continue;
		const field = term.slice(0, i);
		const value = term.slice(i + op.length);
		const v = String(row[field] ?? '');
		switch (op) {
			case '!=': return v !== value;
			case '>=': return v >= value;
			case '<=': return v <= value;
			case 'NOT LIKE': return !v.includes(value);
			case 'STARTSWITH': return v.startsWith(value);
			case 'ISNOTEMPTY': return v !== '';
			case 'ISEMPTY': return v === '';
			case 'LIKE': return v.includes(value);
			case 'IN': return value.split(',').includes(v);
			case '=': return v === value;
		}
	}
	throw new Error(`fake instance cannot evaluate "${term}"`);
}
function evaluate(rows: Row[], query: string): Row[] {
	const parts = query ? query.split('^') : [];
	const order = parts.find(p => p.startsWith('ORDERBY'));
	const groups: string[][] = [];
	for (const p of parts) {
		if (!p || p.startsWith('ORDERBY')) continue;
		if (p.startsWith('OR') && groups.length) groups[groups.length - 1].push(p.slice(2));
		else groups.push([p]);
	}
	let out = rows.filter(r => groups.every(g => g.some(t => matches(r, t))));
	if (order) {
		const desc = order.startsWith('ORDERBYDESC');
		const f = order.slice(desc ? 11 : 7);
		out = out.slice().sort((a, b) => String(a[f] ?? '').localeCompare(String(b[f] ?? '')) * (desc ? -1 : 1));
	}
	return out;
}
function fakeIO(db: Record<string, Row[]>, opts: { restricted?: string[]; failWhen?: (table: string, query: string) => boolean } = {}) {
	const calls: string[] = [];
	const io: ProfileIO = {
		async query(table, query, fields, limit) {
			calls.push(`query ${table}`);
			if (opts.restricted?.includes(table) || opts.failWhen?.(table, query)) throw Object.assign(new Error('denied'), { code: 'E_ACL' });
			return evaluate(db[table] || [], query).slice(0, limit).map(r => Object.fromEntries(fields.map(f => [f, r[f] ?? ''])));
		},
		async count(table, query) {
			calls.push(`count ${table}`);
			if (opts.restricted?.includes(table) || opts.failWhen?.(table, query)) throw Object.assign(new Error('denied'), { code: 'E_ACL' });
			return evaluate(db[table] || [], query).length;
		},
	};
	return { io, calls };
}

const ID = (c: string) => c.repeat(32).slice(0, 32);
const A = ID('a'), B = ID('b'), SET = ID('5'), REASON = ID('7'), COST = ID('8'), URGENT = ID('1'), DETAILS = ID('2');
const POLICY = ID('3'), ACTION = ID('4'), CAT = ID('c'), FLOW = ID('f'), MGR = ID('d'), DEPT = ID('e'), NOTIF = ID('9');

function catalogDb(): Record<string, Row[]> {
	return {
		sc_cat_item: [
			{ sys_id: A, name: 'Item A', sys_class_name: 'sc_cat_item', active: 'true', 'sys_scope.scope': 'x_app', sys_created_by: 'admin', sys_updated_on: '2026-10-18 18:29:58', flow_designer_flow: FLOW, 'flow_designer_flow.name': 'Item request', category: ID('6') },
			{ sys_id: B, name: 'Item B', sys_class_name: 'sc_cat_item', active: 'true', 'sys_scope.scope': 'x_app', sys_created_by: 'admin', sys_updated_on: '2026-10-18 17:57:31' },
		],
		item_option_new: [
			{ sys_id: URGENT, name: 'urgent', cat_item: A },
			{ sys_id: DETAILS, name: 'details', cat_item: A },
			{ sys_id: REASON, name: 'reason', variable_set: SET },
			{ sys_id: COST, name: 'cost', variable_set: SET },
		],
		io_set_item: [
			{ sys_id: ID('p'), sc_cat_item: A, variable_set: SET, 'variable_set.title': 'Shared set' },
			{ sys_id: ID('q'), sc_cat_item: B, variable_set: SET, 'variable_set.title': 'Shared set' },
		],
		catalog_ui_policy: [{ sys_id: POLICY, catalog_item: A, short_description: 'urgent needs reason', catalog_conditions: `IO:${URGENT}=true^EQ` }],
		catalog_ui_policy_action: [{ sys_id: ACTION, catalog_item: A, ui_policy: POLICY, catalog_variable: `IO:${REASON}` }],
		catalog_script_client: [],
		sc_cat_item_catalog: [{ sys_id: ID('r'), sc_cat_item: A, sc_catalog: CAT }, { sys_id: ID('s'), sc_cat_item: B, sc_catalog: CAT }],
		sc_cat_item_category: [{ sys_id: ID('t'), sc_cat_item: A, sc_category: ID('6') }],
		sys_dictionary: [{ name: 'sc_item_option', element: 'item_option_new', reference: 'item_option_new', internal_type: 'reference' }],
		sc_item_option: [{ sys_id: ID('u'), item_option_new: URGENT }],
		sys_hub_action_instance: [{ flow: FLOW, 'action_type.name': 'Create Catalog Task' }, { flow: NOTIF, 'action_type.name': 'Send Email' }],
		sys_hub_sub_flow_instance: [
			{ flow: FLOW, subflow: MGR, 'subflow.name': 'Requested Item Manager Approval' },
			{ flow: FLOW, subflow: DEPT, 'subflow.name': 'Requested Item Dept Head Approval' },
			{ flow: DEPT, subflow: NOTIF, 'subflow.name': 'Requested Item Email Notification' },
			{ flow: NOTIF, subflow: FLOW, 'subflow.name': 'Item request' },
			{ flow: FLOW, subflow: NOTIF, 'subflow.name': 'Requested Item Email Notification' },
			{ flow: MGR, subflow: NOTIF, 'subflow.name': 'Requested Item Email Notification' },
		],
		sys_update_xml: [{ name: `sc_cat_item_${A}` }],
	};
}

const classOf = (members: any[], id: string) => members.find(m => m.sys_id === id)?.class;

test('fixture regression 1: item A with B outside the sample', async () => {
	const { io } = fakeIO(catalogDb());
	const p = await analyzeArtifactType(io, { type: 'catalog_item', instance: 'dev', roots: [A], detail: true, now: '2026-10-18T00:00:00Z' });
	const m = p.sampleReports[0].members!;
	assert.strictEqual(classOf(m, URGENT), 'owned_by_reference');
	assert.strictEqual(classOf(m, DETAILS), 'owned_by_reference');
	assert.strictEqual(classOf(m, POLICY), 'owned_by_reference');
	assert.strictEqual(classOf(m, ACTION), 'owned_by_reference');
	assert.strictEqual(classOf(m, SET), 'shared', 'shared through the instance-wide set link count, not through B');
	assert.strictEqual(m.find(x => x.sys_id === SET)!.consumers, 2);
	assert.strictEqual(classOf(m, REASON), 'inherits_shared');
	assert.strictEqual(classOf(m, COST), 'inherits_shared');
	assert.strictEqual(classOf(m, CAT), 'external');
	for (const id of [B, ID('q'), ID('s')]) assert.strictEqual(classOf(m, id), undefined, `B record ${id} must not appear`);
	assert.strictEqual(m.find(x => x.sys_id === URGENT)!.dataReferences, 1, 'an order answer is a data reference');
});

test('fixture regression 2: the same classification for A with B in the sample', async () => {
	const { io } = fakeIO(catalogDb());
	const alone = await analyzeArtifactType(io, { type: 'catalog_item', instance: 'dev', roots: [A], detail: true });
	const both = await analyzeArtifactType(io, { type: 'catalog_item', instance: 'dev', roots: [A, B], detail: true });
	const pick = (p: any) => p.sampleReports.find((r: any) => r.sys_id === A).members.map((x: any) => `${x.table}:${x.sys_id}:${x.class}`).sort();
	assert.deepStrictEqual(pick(both), pick(alone));
});

test('fixture regression 3: embedded references and inherited sharing are found', async () => {
	const { io } = fakeIO(catalogDb());
	const p = await analyzeArtifactType(io, { type: 'catalog_item', instance: 'dev', roots: [A], detail: true });
	const refs = p.sampleReports[0].embeddedRefs!;
	assert.deepStrictEqual(refs.map(r => [r.from, r.target, r.resolved.belongsTo]).sort(), [
		['catalog_ui_policy.catalog_conditions', URGENT, 'this_root'],
		['catalog_ui_policy_action.catalog_variable', REASON, 'variable_set'],
	].sort());
	assert.strictEqual(p.coverage.unresolvedEmbedded, 0);
});

test('analysis only reads (regression 4, offline part)', async () => {
	const { io, calls } = fakeIO(catalogDb());
	await analyzeArtifactType(io, { type: 'catalog_item', instance: 'dev', roots: [A], detail: true });
	assert.ok(calls.every(c => /^(query|count) /.test(c)));
});

test('fulfillment flows: subflows followed with approval detection, cycle detection and a depth limit', async () => {
	const { io } = fakeIO(catalogDb());
	const p = await analyzeArtifactType(io, { type: 'catalog_item', instance: 'dev', roots: [A] });
	const flow = p.flows![0];
	assert.strictEqual(flow.hasApproval, true);
	assert.strictEqual(flow.hasNotification, true);
	assert.deepStrictEqual(flow.subflows.map(s => s.name).sort(), ['Requested Item Dept Head Approval', 'Requested Item Email Notification', 'Requested Item Manager Approval']);
	assert.deepStrictEqual(flow.cycles, ['Item request'], 'only the call back to an ancestor is a cycle');
	assert.strictEqual(flow.subflows.find(x => x.name === 'Requested Item Email Notification')!.uses, 3, 'repeated use is counted, not reported as a cycle');
	assert.ok(p.warnings.some(w => /approval/.test(w)));
});

function tableDb(): Record<string, Row[]> {
	const t = (name: string, extra: Row = {}) => ({ sys_id: ID(name[name.length - 1]), name, 'sys_scope.scope': 'x_app', sys_scope: ID('9'), sys_created_by: 'dev', sys_created_on: '2026-09-01 10:00:00', sys_updated_on: '2026-09-02 10:00:00', read_access: 'true', create_access: 'false', update_access: 'false', delete_access: 'false', access: 'public', ws_access: 'true', create_access_controls: 'false', ...extra });
	const tables = [t('x_app_t1'), t('x_app_t2'), t('x_app_t3'), t('x_app_t4', { sys_created_by: 'bot', sys_created_on: '2026-10-08 12:24:55' }), t('u_qb_1', { sys_created_by: 'system', sys_scope: 'global' })];
	const acl = (name: string, op: string) => ({ sys_id: ID('z') + op, name, 'operation.name': op });
	return {
		sys_db_object: tables,
		sys_dictionary: tables.flatMap(x => Array.from({ length: 7 }, () => ({ name: x.name }))),
		sys_documentation: tables.flatMap(x => Array.from({ length: 7 }, () => ({ name: x.name }))),
		ua_table_licensing_config: tables.map(x => ({ name: x.name })),
		sys_security_acl: ['x_app_t1', 'x_app_t2', 'x_app_t3'].flatMap(n => ['read', 'write', 'create', 'delete'].map(op => acl(n, op))),
		sys_security_acl_role: ['x_app_t1', 'x_app_t2', 'x_app_t3'].flatMap(n => ['read', 'write', 'create', 'delete'].map(() => ({ 'sys_security_acl.name': n, sys_user_role: ID('r'), 'sys_user_role.name': 'x_app.user' }))),
		sys_app_module: [{ name: 'x_app_t1' }],
		sys_metadata: Array.from({ length: 20 }, (_, i) => ({ sys_scope: ID('9'), sys_created_by: 'bot', sys_created_on: `2026-10-08 12:24:${String(40 + (i % 20)).padStart(2, '0')}` })),
		sys_module: [],
		sys_update_xml: [],
	};
}

test('tables: machine-made tables excluded, labels from evidence, Application Access summarized', async () => {
	const { io } = fakeIO(tableDb());
	const p = await analyzeArtifactType(io, { type: 'table', instance: 'dev', detail: true });
	assert.strictEqual(p.samples.excludedGenerated, 1);
	assert.strictEqual(p.samples.analyzed, 4);
	const sat = (k: string) => p.satellites.find(s => s.key === k)!;
	assert.strictEqual(sat('dictionary').label, 'platform', 'generated on every path tested');
	assert.strictEqual(sat('table_acls').generated.value, 'yes');
	assert.match(sat('table_acls').generated.path!, /UI table form only/);
	assert.strictEqual(sat('table_acls').label, 'choice', '3 of 4 is recurrence, not a rule');
	assert.deepStrictEqual(sat('table_acls').observed, { samples: 3, of: 4, read: 4, unread: 0, perSample: { min: 0, max: 4 } });
	assert.strictEqual(sat('table_acls').required.value, 'no');
	assert.strictEqual(sat('number').label, 'not_observed');
	assert.strictEqual(sat('number').required.value, 'unknown');
	assert.deepStrictEqual(p.applicationAccess!.values.create_access, { false: 4 });
	assert.ok(p.creationPaths.some(c => /API insert/.test(c.statement)));
	const t4 = p.sampleReports.find(r => r.name === 'x_app_t4')!;
	assert.strictEqual(t4.provenance.origin, 'automated_burst');
	assert.strictEqual(t4.provenance.confidence, 'low');
	const role = p.sampleReports.find(r => r.name === 'x_app_t1')!.members!.find(m => m.table === 'sys_user_role')!;
	assert.strictEqual(role.class, 'shared', 'the same role guards other tables');
	assert.ok(p.deferred.some(d => /non-admin/.test(d)));
});

test('too few samples or restricted probes make labels unknown, and coverage says so', async () => {
	const { io } = fakeIO(tableDb(), { restricted: ['sys_app_module'] });
	const p = await analyzeArtifactType(io, { type: 'table', instance: 'dev', roots: [ID('1'), ID('2')] });
	assert.strictEqual(p.satellites.find(s => s.key === 'table_acls')!.label, 'unknown');
	assert.strictEqual(p.satellites.find(s => s.key === 'dictionary')!.label, 'platform', 'recorded experiments do not depend on sample size');
	assert.deepStrictEqual(p.satellites.find(s => s.key === 'module')!.observed, { samples: 0, of: 2, read: 0, unread: 2, perSample: null });
	assert.strictEqual(p.satellites.find(s => s.key === 'module')!.label, 'unknown');
	assert.ok(p.coverage.probes.some(c => c.key === 'module' && c.status === 'restricted'));
	assert.ok(p.warnings.some(w => /could not be read/.test(w)));
	assert.ok(p.warnings.some(w => /Only 2 sample/.test(w)));
});

test('reuse: identity and fingerprint decide freshness', async () => {
	const db = tableDb();
	const { io } = fakeIO(db);
	const params = { type: 'table' as const, instance: 'dev' };
	const p = await analyzeArtifactType(io, params);
	assert.strictEqual(p.analyzerVersion, ANALYZER_VERSION);
	let fp = await currentFingerprint(io, p);
	assert.deepStrictEqual(profileStillFresh(p, params, fp), { fresh: true, reason: 'fingerprint unchanged' });
	db.sys_security_acl.push({ sys_id: ID('y'), name: 'x_app_t4', sys_updated_on: '2026-10-19 09:00:00' });
	fp = await currentFingerprint(io, p);
	assert.strictEqual(profileStillFresh(p, params, fp).fresh, false);
	assert.strictEqual(profileStillFresh(p, { ...params, scope: 'x_other' }, fp).fresh, false);
	assert.strictEqual(profileStillFresh({ ...p, analyzerVersion: '0.9.0' }, params, fp).fresh, false);
	assert.match(profileStillFresh(p, { ...params, detail: true }, await currentFingerprint(io, p)).reason, /no per-sample detail/);
});

test('parameters and file names', () => {
	assert.throws(() => validateProfileParams({ type: 'ui_page' }), /Unsupported/);
	assert.throws(() => validateProfileParams({ type: 'table', roots: ['x'] }), /roots/);
	assert.throws(() => validateProfileParams({ type: 'table', query: 'active=true^NQname=x' }), /plain encoded query/);
	assert.throws(() => validateProfileParams({ type: 'table', sample: 31 }), /sample/);
	assert.strictEqual(profileFileName({ type: 'table', instance: 'x' }), 'table.any.profile.json');
	assert.strictEqual(profileFileName({ type: 'catalog_item', instance: 'x', roots: [A, B] }), profileFileName({ type: 'catalog_item', instance: 'x', roots: [B, A] }));
	assert.notStrictEqual(profileFileName({ type: 'catalog_item', instance: 'x', roots: [A] }), profileFileName({ type: 'catalog_item', instance: 'x' }));
	assert.strictEqual(shiftTime('2026-10-08 12:24:55', 30), '2026-10-08 12:25:25');
});

// ---- review findings 2026-10-18, each reproduced before the fix

test('reuse needs the same selection: sample size and the generated filter change the identity', async () => {
	const { io } = fakeIO(tableDb());
	const p = await analyzeArtifactType(io, { type: 'table', instance: 'dev', sample: 1 });
	const fp = await currentFingerprint(io, p);
	assert.strictEqual(profileStillFresh(p, { type: 'table', instance: 'dev', sample: 1 }, fp).fresh, true);
	assert.match(profileStillFresh(p, { type: 'table', instance: 'dev', sample: 12 }, fp).reason, /different sample/);
	assert.match(profileStillFresh(p, { type: 'table', instance: 'dev', sample: 1, includeGenerated: true }, fp).reason, /different includeGenerated/);
	assert.match(profileStillFresh(p, { type: 'table', instance: 'dev', sample: 1, query: 'nameSTARTSWITHx_app' }, fp).reason, /different query/);
});

test('reuse: a change to a flow or subflow call invalidates a catalog item profile', async () => {
	const db = catalogDb();
	const { io } = fakeIO(db);
	const p = await analyzeArtifactType(io, { type: 'catalog_item', instance: 'dev', roots: [A] });
	assert.strictEqual(profileStillFresh(p, { type: 'catalog_item', instance: 'dev', roots: [A] }, await currentFingerprint(io, p)).fresh, true);
	db.sys_hub_sub_flow_instance.push({ flow: FLOW, subflow: ID('0'), 'subflow.name': 'New approval', sys_updated_on: '2026-10-19 08:00:00' });
	assert.match(profileStillFresh(p, { type: 'catalog_item', instance: 'dev', roots: [A] }, await currentFingerprint(io, p)).reason, /sys_hub_sub_flow_instance changed/);
});

test('ownership does not depend on result order: another item using the variable beyond any row limit makes it shared', async () => {
	const db = catalogDb();
	const other = ID('9');
	for (let i = 0; i < 60; i++) db.catalog_ui_policy.push({ sys_id: 'p' + String(i).padStart(31, '0'), catalog_item: other, catalog_conditions: `IO:${URGENT}=false^EQ` });
	const { io } = fakeIO(db);
	const p = await analyzeArtifactType(io, { type: 'catalog_item', instance: 'dev', roots: [A], detail: true });
	const urgent = p.sampleReports[0].members!.find(m => m.sys_id === URGENT)!;
	assert.strictEqual(urgent.class, 'shared');
	assert.strictEqual(urgent.consumers, 60);
});

test('a consumer count that cannot be read makes the variable unknown, never owned, and says so', async () => {
	const { io } = fakeIO(catalogDb(), { failWhen: (table, query) => table === 'catalog_script_client' && query.includes('LIKE') });
	const p = await analyzeArtifactType(io, { type: 'catalog_item', instance: 'dev', roots: [A], detail: true });
	const report = p.sampleReports[0];
	assert.strictEqual(report.members!.find(m => m.sys_id === URGENT)!.class, 'unknown');
	assert.ok(report.memberNotes!.some(n => /could not be counted/.test(n)));
	assert.ok(p.warnings.some(w => /may be incomplete/.test(w)));
});

test('one unread sample keeps recurrence open: "3 of 3 read" is unknown, not convention', async () => {
	const db = tableDb();
	// All four authored tables have the four ACLs, so a full read would be a convention.
	db.sys_security_acl.push(...['read', 'write', 'create', 'delete'].map(op => ({ sys_id: ID('w') + op, name: 'x_app_t4', 'operation.name': op })));
	const full = await analyzeArtifactType(fakeIO(db).io, { type: 'table', instance: 'dev' });
	assert.strictEqual(full.satellites.find(s => s.key === 'table_acls')!.label, 'convention');
	const { io } = fakeIO(db, { failWhen: (table, query) => table === 'sys_security_acl' && query === 'name=x_app_t4' });
	const p = await analyzeArtifactType(io, { type: 'table', instance: 'dev' });
	const acls = p.satellites.find(s => s.key === 'table_acls')!;
	assert.deepStrictEqual({ label: acls.label, of: acls.observed!.of, read: acls.observed!.read, unread: acls.observed!.unread }, { label: 'unknown', of: 4, read: 3, unread: 1 });
	assert.ok(p.coverage.probes.some(c => c.key === 'table_acls' && c.status === 'restricted'));
});

test('a subflow first met at the depth limit is still expanded when the root calls it directly, in any record order', async () => {
	const R = ID('a'), X = ID('b'), Y = ID('c'), Z = ID('d'), M = ID('e');
	const calls = [
		{ flow: R, subflow: X, 'subflow.name': 'X' },
		{ flow: X, subflow: Y, 'subflow.name': 'Y' },
		{ flow: Y, subflow: Z, 'subflow.name': 'Z' },
		{ flow: R, subflow: Z, 'subflow.name': 'Z' },
		{ flow: Z, subflow: M, 'subflow.name': 'Manager Approval' },
	];
	for (const order of [calls, calls.slice().reverse()]) {
		const db: Record<string, Row[]> = {
			sc_cat_item: [{ sys_id: ID('1'), name: 'Item', sys_class_name: 'sc_cat_item', active: 'true', flow_designer_flow: R, 'flow_designer_flow.name': 'Root' }],
			sys_hub_sub_flow_instance: order, sys_hub_action_instance: [],
		};
		const p = await analyzeArtifactType(fakeIO(db).io, { type: 'catalog_item', instance: 'dev', roots: [ID('1')] });
		const flow = p.flows![0];
		assert.strictEqual(flow.hasApproval, true, 'approval two levels below a directly called subflow');
		assert.strictEqual(flow.subflows.find(x => x.name === 'Z')!.depth, 1);
		assert.strictEqual(flow.subflows.find(x => x.name === 'Z')!.uses, 2);
		assert.deepStrictEqual(flow.cycles, []);
	}
});
