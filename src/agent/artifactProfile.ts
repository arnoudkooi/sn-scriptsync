/**
 * analyze_artifact_type: learn how an artifact type is built on this instance
 * by sampling existing artifacts and comparing them into a type profile.
 *
 * Read-only by contract: the engine only reads through the injected
 * ProfileIO (query, count, metadata). It never creates, repairs or generates.
 *
 * Three things are kept apart and never inferred from each other:
 * - observed: how many samples have it (recurrence);
 * - generated: the platform or a creation path makes it, known only from a
 *   recorded experiment (KNOWLEDGE below), never from matching counts;
 * - required: the artifact needs it to work, known only from a recorded
 *   experiment or documentation. Otherwise `unknown`.
 *
 * Pure logic, no imports: the standalone bridge mirrors this file verbatim
 * (packages/snu/src/server/artifactProfile.ts), and the bridge parity test
 * checks the copies are identical.
 */

export const ANALYZER_VERSION = '1.1.0';
export const PROFILE_SAMPLE_DEFAULT = 12;
export const PROFILE_SAMPLE_MAX = 30;
/** Subflow levels followed below a sampled fulfillment flow. */
export const FLOW_DEPTH_MAX = 3;
/** Reference fields scanned per target table when looking for other users of a record. */
export const REF_FIELDS_MAX = 60;

export type ArtifactType = 'table' | 'catalog_item';
export const ARTIFACT_TYPES: ArtifactType[] = ['table', 'catalog_item'];

/** Reads the engine may perform. Values may be plain strings or { value, display_value }. */
export interface ProfileIO {
	query(table: string, query: string, fields: string[], limit: number): Promise<Record<string, any>[]>;
	count(table: string, query: string): Promise<number>;
}

export type Tri = 'yes' | 'no' | 'unknown';

export interface Evidence {
	source: 'experiment' | 'observed_in_generation_test' | 'documentation';
	instance?: string;
	date?: string;
	note: string;
}

export interface Facet {
	value: Tri;
	evidence?: Evidence;
	path?: string;
}

export type SatelliteLabel = 'platform' | 'convention' | 'choice' | 'not_observed' | 'unknown';

export interface SatelliteStat {
	key: string;
	table: string;
	link: string;
	linkKind: 'reference' | 'name' | 'm2m';
	/** samples: read samples that have it; of: all samples; unread: samples whose probe failed. */
	observed: { samples: number; of: number; read: number; unread: number; perSample: { min: number; max: number } | null } | null;
	generated: Facet;
	required: Facet;
	label: SatelliteLabel;
	notes?: string[];
}

export type MemberClass = 'root' | 'owned_by_reference' | 'shared' | 'inherits_shared' | 'no_other_use_found' | 'external' | 'unknown';

export interface Member {
	table: string;
	sys_id: string;
	class: MemberClass;
	via: string;
	name?: string;
	/** Configuration records outside this root that use it (embedded IO:<sys_id>, set links). */
	consumers?: number;
	/** Rows elsewhere with a reference to it, such as order answers; reported, never used to classify. */
	dataReferences?: number;
}

export interface EmbeddedRef {
	from: string;
	record: string;
	pattern: string;
	target: string;
	resolved: { table: string; belongsTo: 'this_root' | 'variable_set' | 'other_root' | 'not_found' };
}

export interface Provenance {
	origin: 'servicenow_plugin' | 'platform_generated' | 'now_sdk_install' | 'automated_burst' | 'customer_built' | 'unknown';
	confidence: 'low' | 'medium' | 'high';
	signals: Record<string, string | number | boolean | null>;
}

export interface SampleReport {
	sys_id: string;
	name: string;
	scope: string;
	provenance: Provenance;
	satellites: Record<string, number | null>;
	fields: Record<string, string>;
	members?: Member[];
	embeddedRefs?: EmbeddedRef[];
	/** Why the member list may be incomplete: reads that failed or hit their row limit. */
	memberNotes?: string[];
	flow?: FlowReport;
}

export interface FlowReport {
	sys_id: string;
	name: string;
	/** Distinct subflows below the flow; `uses` counts how often each is called. */
	subflows: Array<{ name: string; sys_id: string; depth: number; uses: number; approval: boolean; notification: boolean }>;
	actions: string[];
	hasApproval: boolean;
	hasNotification: boolean;
	truncated: boolean;
	/** Subflows that call one of their own ancestors (a real loop), not repeated use. */
	cycles: string[];
}

export interface Coverage {
	probes: Array<{ key: string; table: string; status: 'ok' | 'restricted' | 'error'; detail?: string }>;
	embeddedPatterns: string[];
	referenceFieldsScanned: Record<string, number>;
	limits: { sample: number; flowDepth: number; referenceFieldsPerTable: number };
	unresolvedEmbedded: number;
	access: string;
}

export interface ArtifactProfile {
	profile: 'snu.artifact_type_profile';
	analyzerVersion: string;
	type: ArtifactType;
	rootTable: string;
	instance: string;
	scope: string | null;
	generatedAt: string;
	samples: { requested: number; analyzed: number; excludedGenerated: number; selection: string };
	/** What decided the sample; a saved profile is reused only for the same selection. */
	selectionParams: { roots: string[] | null; query: string | null; scope: string | null; sample: number; includeGenerated: boolean; detail: boolean };
	evidenceTimestamps: { newestSampleUpdate: string | null; oldestSampleUpdate: string | null };
	satellites: SatelliteStat[];
	rootFields: Array<{ field: string; values: Record<string, number>; note?: string }>;
	creationPaths: Array<{ statement: string; evidence: Evidence }>;
	applicationAccess?: { values: Record<string, Record<string, number>>; finding: { statement: string; evidence: Evidence } };
	flows?: FlowReport[];
	sampleReports: SampleReport[];
	coverage: Coverage;
	freshness: { fingerprint: Record<string, string>; limitation: string };
	warnings: string[];
	deferred: string[];
}

// ---------------------------------------------------------------- knowledge

const SPIKE = (note: string, source: Evidence['source'] = 'experiment'): Evidence => ({ source, instance: 'dev436517', date: '2026-10-18', note });

interface ProbeDef {
	key: string;
	table: string;
	/** Encoded query; {name} and {id} are replaced per sample. */
	query: string;
	link: string;
	linkKind: SatelliteStat['linkKind'];
	generated?: Facet;
	required?: Facet;
	notes?: string[];
	/** Field on the satellite that makes it part of the root (structural ownership). */
	container?: string;
}

interface TypeDef {
	type: ArtifactType;
	rootTable: string;
	defaultQuery: string;
	sampleFields: string[];
	nameField: string;
	generatedFilter?: { field: string; value: string; note: string };
	probes: ProbeDef[];
	rootFields: string[];
	creationPaths: Array<{ statement: string; evidence: Evidence }>;
}

const TABLE_DEF: TypeDef = {
	type: 'table',
	rootTable: 'sys_db_object',
	defaultQuery: 'nameSTARTSWITHx_^ORnameSTARTSWITHu_^ORDERBYDESCsys_updated_on',
	sampleFields: ['sys_id', 'name', 'sys_scope', 'sys_scope.scope', 'sys_package.name', 'sys_created_by', 'sys_created_on', 'sys_updated_on',
		'create_access_controls', 'user_role', 'read_access', 'create_access', 'update_access', 'delete_access', 'access', 'ws_access', 'super_class.name'],
	nameField: 'name',
	generatedFilter: { field: 'sys_created_by', value: 'system', note: 'Tables created by the system user (for example CMDB query builder results) are machine-made and excluded from the sample.' },
	probes: [
		{ key: 'dictionary', table: 'sys_dictionary', query: 'name={name}', link: 'name = <table>', linkKind: 'name',
			generated: { value: 'yes', path: 'every path tested (UI form, API insert, create_table)', evidence: SPIKE('Collection entry plus one entry per system field appeared for all three creation paths.') } },
		{ key: 'documentation', table: 'sys_documentation', query: 'name={name}', link: 'name = <table>', linkKind: 'name',
			generated: { value: 'yes', path: 'every path tested', evidence: SPIKE('One per dictionary entry for all three creation paths.') } },
		{ key: 'licensing_config', table: 'ua_table_licensing_config', query: 'name={name}', link: 'name = <table>', linkKind: 'name',
			generated: { value: 'yes', path: 'every path tested', evidence: SPIKE('Created for all three creation paths.') } },
		{ key: 'table_acls', table: 'sys_security_acl', query: 'name={name}', link: 'name = <table>', linkKind: 'name',
			generated: { value: 'yes', path: 'UI table form only', evidence: SPIKE('The UI form generated read, write, create and delete record ACLs; an API insert with create_access_controls = true and create_table generated none.') },
			required: { value: 'no', evidence: SPIKE('Without table ACLs a scoped table works for admins and denies every non-admin user (closed, not open); with the four ACLs the role holder gets all four operations (ACL evaluation per impersonated user).') } },
		{ key: 'field_acls', table: 'sys_security_acl', query: 'nameSTARTSWITH{name}.', link: 'name = <table>.<field>', linkKind: 'name' },
		{ key: 'acl_role_links', table: 'sys_security_acl_role', query: 'sys_security_acl.name={name}', link: 'sys_security_acl.name = <table>', linkKind: 'reference',
			generated: { value: 'yes', path: 'UI table form only', evidence: SPIKE('One per generated ACL, all to the role named in the form.') } },
		{ key: 'module', table: 'sys_app_module', query: 'name={name}', link: 'name = <table>', linkKind: 'name',
			notes: ['The UI table form creates modules unless "Create module" and "Create mobile module" are unticked (observed in the generation test).'] },
		{ key: 'form_section', table: 'sys_ui_section', query: 'name={name}', link: 'name = <table>', linkKind: 'name' },
		{ key: 'list_layout', table: 'sys_ui_list', query: 'name={name}', link: 'name = <table>', linkKind: 'name' },
		{ key: 'number', table: 'sys_number', query: 'category={name}', link: 'category = <table>', linkKind: 'name' },
		{ key: 'business_rules', table: 'sys_script', query: 'collection={name}', link: 'collection = <table>', linkKind: 'name' },
		{ key: 'client_scripts', table: 'sys_script_client', query: 'table={name}', link: 'table = <table>', linkKind: 'name' },
		{ key: 'ui_policies', table: 'sys_ui_policy', query: 'table={name}', link: 'table = <table>', linkKind: 'name' },
		{ key: 'ui_actions', table: 'sys_ui_action', query: 'table={name}', link: 'table = <table>', linkKind: 'name' },
		{ key: 'choices', table: 'sys_choice', query: 'name={name}', link: 'name = <table>', linkKind: 'name' },
	],
	rootFields: ['create_access_controls', 'super_class.name'],
	creationPaths: [
		{ statement: 'The UI table form makes "Create access controls" checked and read-only for a scoped table and requires a user role; it creates that role (a custom name typed into the field works) and four record ACLs linked to it.', evidence: SPIKE('Matched UI / API experiment and the generation test.') },
		{ statement: 'An API insert on sys_db_object, also with create_access_controls = true, and create_table create no role and no ACLs. An agent building through the API has to create them deliberately, or use the UI form for this step.', evidence: SPIKE('Matched UI / API experiment.') },
		{ statement: 'create_access_controls and user_role are stored on the table record when the UI form creates them; they were empty on older samples and are not evidence of access on their own.', evidence: SPIKE('Generation test.', 'observed_in_generation_test') },
		{ statement: 'Deleting sys_security_acl records needed the security_admin elevated role; dropping the table removed its ACLs and their role links.', evidence: SPIKE('Experiment cleanup.') },
	],
};

const CATALOG_ITEM_DEF: TypeDef = {
	type: 'catalog_item',
	rootTable: 'sc_cat_item',
	defaultQuery: 'sys_class_name=sc_cat_item^active=true^ORDERBYDESCsys_updated_on',
	sampleFields: ['sys_id', 'name', 'sys_scope', 'sys_scope.scope', 'sys_package.name', 'sys_created_by', 'sys_created_on', 'sys_updated_on',
		'flow_designer_flow', 'flow_designer_flow.name', 'workflow', 'category', 'sc_catalogs', 'active'],
	nameField: 'name',
	probes: [
		{ key: 'variables', table: 'item_option_new', query: 'cat_item={id}', link: 'cat_item -> item', linkKind: 'reference', container: 'cat_item' },
		{ key: 'variable_set_links', table: 'io_set_item', query: 'sc_cat_item={id}', link: 'sc_cat_item -> item, variable_set -> set', linkKind: 'm2m', container: 'sc_cat_item',
			notes: ['A variable set is a shared dependency: link the existing set with io_set_item, never copy it.'] },
		{ key: 'catalog_links', table: 'sc_cat_item_catalog', query: 'sc_cat_item={id}', link: 'sc_cat_item -> item (m2m with sc_catalog)', linkKind: 'm2m', container: 'sc_cat_item',
			generated: { value: 'yes', path: 'setting sc_catalogs on the item', evidence: SPIKE('The platform created the link row from the item field; inserting it by hand would duplicate it.', 'observed_in_generation_test') } },
		{ key: 'category_links', table: 'sc_cat_item_category', query: 'sc_cat_item={id}', link: 'sc_cat_item -> item (m2m with sc_category)', linkKind: 'm2m', container: 'sc_cat_item',
			generated: { value: 'yes', path: 'setting category on the item', evidence: SPIKE('The platform created the link row from the item field.', 'observed_in_generation_test') } },
		{ key: 'ui_policies', table: 'catalog_ui_policy', query: 'catalog_item={id}', link: 'catalog_item -> item', linkKind: 'reference', container: 'catalog_item',
			notes: ['Variables are referenced in catalog_conditions as IO:<variable sys_id>. The policy record itself, including catalog_conditions, works through the Table API.'] },
		{ key: 'ui_policy_actions', table: 'catalog_ui_policy_action', query: 'catalog_item={id}', link: 'catalog_item -> item, ui_policy -> policy, catalog_variable = IO:<variable>', linkKind: 'reference', container: 'catalog_item',
			notes: ['Writing ui_policy and catalog_variable through the Table API came back empty (cause not isolated); the Catalog UI Policy form related list kept both, with business rules running.'] },
		{ key: 'client_scripts', table: 'catalog_script_client', query: 'cat_item={id}', link: 'cat_item -> item', linkKind: 'reference', container: 'cat_item' },
		{ key: 'available_for', table: 'sc_cat_item_user_criteria_mtom', query: 'sc_cat_item={id}', link: 'sc_cat_item -> item', linkKind: 'm2m', container: 'sc_cat_item' },
		{ key: 'not_available_for', table: 'sc_cat_item_user_criteria_no_mtom', query: 'sc_cat_item={id}', link: 'sc_cat_item -> item', linkKind: 'm2m', container: 'sc_cat_item' },
	],
	rootFields: ['flow_designer_flow.name', 'workflow', 'category', 'active'],
	creationPaths: [
		{ statement: 'Setting sc_catalogs and category on the item makes the platform create the sc_cat_item_catalog and sc_cat_item_category rows.', evidence: SPIKE('Generation test.', 'observed_in_generation_test') },
		{ statement: 'catalog_ui_policy_action.ui_policy and catalog_variable written through the Table API came back empty; the action created from the Catalog UI Policy form kept both and worked in the portal. The cause of the API loss is not isolated.', evidence: SPIKE('Fixture creation, verified update and the generation test.') },
		{ statement: 'Ordering through POST /api/sn_sc/servicecatalog/items/<id>/order_now creates a request and a requested item; the fulfillment flow then runs on the requested item.', evidence: SPIKE('Generation test.') },
	],
};

const TYPES: Record<ArtifactType, TypeDef> = { table: TABLE_DEF, catalog_item: CATALOG_ITEM_DEF };

/** IO:<sys_id> references to catalog variables, and where to look for them. */
const EMBEDDED_PATTERNS: Array<{ table: string; field: string; rootField: string }> = [
	{ table: 'catalog_ui_policy', field: 'catalog_conditions', rootField: 'catalog_item' },
	{ table: 'catalog_ui_policy_action', field: 'catalog_variable', rootField: 'catalog_item' },
	{ table: 'catalog_script_client', field: 'script', rootField: 'cat_item' },
];

// ---------------------------------------------------------------- helpers

const SYS_ID = /^[0-9a-f]{32}$/i;
const IO_REF = /IO:([0-9a-f]{32})/gi;

export function val(v: any): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'object') return v.value === undefined || v.value === null ? '' : String(v.value);
	return String(v);
}

function fill(query: string, sample: { name: string; id: string }): string {
	return query.replace(/\{name\}/g, sample.name).replace(/\{id\}/g, sample.id);
}

function fail(message: string): never {
	throw Object.assign(new Error(message), { code: 'E_INVALID_PARAMS' as const });
}

export interface ProfileParams {
	type: ArtifactType;
	instance: string;
	/** Explicit roots (sys_ids). When given they are the whole sample. */
	roots?: string[];
	/** Extra encoded query ANDed with the type's default selection. */
	query?: string;
	scope?: string;
	sample?: number;
	/** Include per-sample members and embedded references. */
	detail?: boolean;
	includeGenerated?: boolean;
	now?: string;
}

export function validateProfileParams(params: any): ProfileParams {
	const p = params && typeof params === 'object' ? params : {};
	if (!ARTIFACT_TYPES.includes(p.type)) fail(`Unsupported or missing "type". Supported: ${ARTIFACT_TYPES.join(', ')}. UI Builder pages and other types are not profiled in this version.`);
	let roots: string[] | undefined;
	if (p.roots !== undefined) {
		if (!Array.isArray(p.roots) || !p.roots.length || p.roots.length > PROFILE_SAMPLE_MAX || p.roots.some((r: unknown) => typeof r !== 'string' || !SYS_ID.test(r))) {
			fail(`"roots" must be 1 to ${PROFILE_SAMPLE_MAX} sys_ids`);
		}
		roots = Array.from(new Set((p.roots as string[]).map(r => r.toLowerCase())));
	}
	if (p.query !== undefined && (typeof p.query !== 'string' || /\^NQ|javascript:/i.test(p.query))) fail('"query" must be a plain encoded query (no ^NQ, no javascript:)');
	if (p.scope !== undefined && (typeof p.scope !== 'string' || !/^[a-z0-9_]+$/i.test(p.scope))) fail('"scope" must be an application scope name');
	let sample = PROFILE_SAMPLE_DEFAULT;
	if (p.sample !== undefined) {
		const n = Number(p.sample);
		if (!Number.isInteger(n) || n < 1 || n > PROFILE_SAMPLE_MAX) fail(`"sample" must be 1 to ${PROFILE_SAMPLE_MAX}`);
		sample = n;
	}
	return { type: p.type, instance: String(p.instance || ''), roots, query: p.query, scope: p.scope, sample, detail: p.detail === true, includeGenerated: p.includeGenerated === true };
}

/** Stable file name for a saved profile: type, scope, explicit roots. */
export function profileFileName(params: ProfileParams): string {
	const parts = [params.type, params.scope || 'any'];
	if (params.roots?.length) {
		// Short, stable digest of the root list (FNV-1a), so explicit-root profiles do not overwrite the sampled one.
		let h = 0x811c9dc5;
		for (const ch of params.roots.slice().sort().join(',')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
		parts.push('roots-' + h.toString(16));
	}
	if (params.query) {
		let h = 0x811c9dc5;
		for (const ch of params.query) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
		parts.push('q-' + h.toString(16));
	}
	return parts.join('.') + '.profile.json';
}

// ---------------------------------------------------------------- engine

export async function analyzeArtifactType(io: ProfileIO, raw: ProfileParams): Promise<ArtifactProfile> {
	const params = validateProfileParams(raw);
	const def = TYPES[params.type];
	const now = raw.now || new Date().toISOString();
	const coverage: Coverage = {
		probes: [],
		embeddedPatterns: params.type === 'catalog_item' ? EMBEDDED_PATTERNS.map(p => `IO:<sys_id> in ${p.table}.${p.field}`) : [],
		referenceFieldsScanned: {},
		limits: { sample: params.sample || PROFILE_SAMPLE_DEFAULT, flowDepth: FLOW_DEPTH_MAX, referenceFieldsPerTable: REF_FIELDS_MAX },
		unresolvedEmbedded: 0,
		access: 'Every read and count runs as the connected user and is filtered by that user\'s ACLs: rows the user cannot read are invisible and are not reported as missing.',
	};
	const warnings: string[] = [];
	const probeStatus = new Map<string, Coverage['probes'][number]>();
	const note = (key: string, table: string, status: 'ok' | 'restricted' | 'error', detail?: string) => {
		const prev = probeStatus.get(key);
		if (!prev || prev.status === 'ok') probeStatus.set(key, { key, table, status, ...(detail ? { detail } : {}) });
	};
	const safeCount = async (key: string, table: string, query: string): Promise<number | null> => {
		try { const n = await io.count(table, query); note(key, table, 'ok'); return n; }
		catch (err: any) { note(key, table, /E_ACL|E_UNAUTHORIZED|403/.test(String(err?.code || err?.message)) ? 'restricted' : 'error', String(err?.code || err?.message || err)); return null; }
	};
	const safeQuery = async (key: string, table: string, query: string, fields: string[], limit: number): Promise<Record<string, any>[] | null> => {
		try { const rows = await io.query(table, query, fields, limit); note(key, table, 'ok'); return rows; }
		catch (err: any) { note(key, table, /E_ACL|E_UNAUTHORIZED|403/.test(String(err?.code || err?.message)) ? 'restricted' : 'error', String(err?.code || err?.message || err)); return null; }
	};

	// 1. Samples.
	let selection: string;
	let rootRows: Record<string, any>[];
	let excludedGenerated = 0;
	if (params.roots) {
		selection = `explicit roots (${params.roots.length})`;
		rootRows = (await safeQuery('root', def.rootTable, `sys_idIN${params.roots.join(',')}`, def.sampleFields, params.roots.length)) || [];
		const found = new Set(rootRows.map(r => val(r.sys_id)));
		const missing = params.roots.filter(r => !found.has(r));
		if (missing.length) warnings.push(`${missing.length} requested root(s) not found or not readable: ${missing.join(', ')}`);
	} else {
		const clauses = [def.defaultQuery.replace(/\^ORDERBY.*$/, '')];
		if (params.query) clauses.push(params.query);
		if (params.scope) clauses.push(`sys_scope.scope=${params.scope}`);
		let query = clauses.join('^');
		if (def.generatedFilter && !params.includeGenerated) {
			const generated = await safeCount('root', def.rootTable, `${query}^${def.generatedFilter.field}=${def.generatedFilter.value}`);
			excludedGenerated = generated || 0;
			query += `^${def.generatedFilter.field}!=${def.generatedFilter.value}`;
		}
		const order = def.defaultQuery.match(/\^(ORDERBY.*)$/)?.[1];
		selection = `${query}${order ? '^' + order : ''} (first ${params.sample})`;
		rootRows = (await safeQuery('root', def.rootTable, order ? `${query}^${order}` : query, def.sampleFields, params.sample || PROFILE_SAMPLE_DEFAULT)) || [];
		if (excludedGenerated) warnings.push(`${excludedGenerated} machine-made record(s) excluded: ${def.generatedFilter!.note}`);
	}
	if (!rootRows.length) warnings.push('No samples could be read; nothing below is evidence.');
	if (rootRows.length > 0 && rootRows.length < 3) warnings.push(`Only ${rootRows.length} sample(s): recurrence is not established, labels other than recorded experiment findings are "unknown".`);

	// 2. Per sample: satellites, provenance, flow, members.
	const reports: SampleReport[] = [];
	const flowCache = new Map<string, FlowReport>();
	for (const row of rootRows) {
		const id = val(row.sys_id);
		const name = val(row[def.nameField]);
		const scope = val(row['sys_scope.scope']) || val(row.sys_scope);
		const sats: Record<string, number | null> = {};
		for (const probe of def.probes) sats[probe.key] = await safeCount(probe.key, probe.table, fill(probe.query, { name, id }));
		const fields: Record<string, string> = {};
		for (const f of def.rootFields) fields[f] = val(row[f]);
		const report: SampleReport = { sys_id: id, name, scope, provenance: await provenanceFor(def, row, safeCount, safeQuery), satellites: sats, fields };
		if (def.type === 'table') {
			for (const f of ['read_access', 'create_access', 'update_access', 'delete_access', 'access', 'ws_access', 'user_role']) report.fields[f] = val(row[f]);
		}
		if (def.type === 'catalog_item') {
			const flowId = val(row.flow_designer_flow);
			if (flowId) {
				if (!flowCache.has(flowId)) flowCache.set(flowId, await profileFlow(flowId, val(row['flow_designer_flow.name']), safeQuery));
				report.flow = flowCache.get(flowId);
			}
			if (params.detail) {
				const m = await catalogMembers(id, safeQuery, safeCount, coverage);
				report.members = m.members;
				report.embeddedRefs = m.embedded;
				if (m.notes.length) report.memberNotes = m.notes;
				coverage.unresolvedEmbedded += m.embedded.filter(e => e.resolved.belongsTo === 'not_found').length;
			}
		}
		if (def.type === 'table' && params.detail) {
			const m = await tableMembers(name, safeQuery, safeCount);
			report.members = m.members;
			if (m.notes.length) report.memberNotes = m.notes;
		}
		if (report.memberNotes?.length) warnings.push(`Member list for ${name || id} may be incomplete: ${report.memberNotes.join('; ')}`);
		reports.push(report);
	}

	// 3. Compare samples.
	const n = reports.length;
	const satellites: SatelliteStat[] = def.probes.map(probe => {
		const counts = reports.map(r => r.satellites[probe.key]).filter((c): c is number => typeof c === 'number');
		const unread = reports.length - counts.length;
		const observed = reports.length ? {
			samples: counts.filter(c => c > 0).length, of: reports.length, read: counts.length, unread,
			perSample: counts.length ? { min: Math.min(...counts), max: Math.max(...counts) } : null,
		} : null;
		const generated: Facet = probe.generated || { value: 'unknown' };
		const required: Facet = probe.required || { value: 'unknown' };
		let label: SatelliteLabel;
		if (generated.value === 'yes' && /every path/.test(generated.path || '')) label = 'platform';
		// A sample that could not be read leaves recurrence open: "3 of 3 read" is not "4 of 4".
		else if (!observed || unread > 0 || observed.of < 3) label = 'unknown';
		else if (observed.samples === observed.of) label = 'convention';
		else if (observed.samples === 0) label = 'not_observed';
		else label = 'choice';
		return { key: probe.key, table: probe.table, link: probe.link, linkKind: probe.linkKind, observed, generated, required, label, ...(probe.notes ? { notes: probe.notes } : {}) };
	});
	const rootFields = def.rootFields.map(field => {
		const values: Record<string, number> = {};
		for (const r of reports) { const v = r.fields[field] || '(empty)'; values[v] = (values[v] || 0) + 1; }
		return { field, values };
	});

	const profile: ArtifactProfile = {
		profile: 'snu.artifact_type_profile',
		analyzerVersion: ANALYZER_VERSION,
		type: def.type,
		rootTable: def.rootTable,
		instance: params.instance,
		scope: params.scope || null,
		generatedAt: now,
		samples: { requested: params.roots ? params.roots.length : (params.sample || PROFILE_SAMPLE_DEFAULT), analyzed: n, excludedGenerated, selection },
		selectionParams: selectionOf(params),
		evidenceTimestamps: sampleTimes(rootRows),
		satellites,
		rootFields,
		creationPaths: def.creationPaths,
		sampleReports: reports,
		coverage,
		freshness: { fingerprint: {}, limitation: '' },
		warnings,
		deferred: [
			'UI Builder pages: profiled read-only in the spike, not by this command; generation is deferred.',
			'Table access: verified by ACL evaluation per impersonated user only; create, read, update and delete through a non-admin user\'s own session is unverified.',
			'General flow profiling: only the fulfillment flows of sampled catalog items are followed, with their subflows.',
		],
	};

	if (def.type === 'table') {
		const values: Record<string, Record<string, number>> = {};
		for (const f of ['read_access', 'create_access', 'update_access', 'delete_access', 'access', 'ws_access']) {
			values[f] = {};
			for (const r of reports) { const v = r.fields[f] || '(empty)'; values[f][v] = (values[f][v] || 0) + 1; }
		}
		profile.applicationAccess = {
			values,
			finding: { statement: 'Application Access on a new scoped table lets other scopes (Global included) read only: create, update and delete from scripts in other scopes are refused regardless of ACLs. Seed or maintain such a table from its own scope.', evidence: SPIKE('Generation test: a Global background script could not insert, even as admin; the table record had read_access true, create_access, update_access and delete_access false.') },
		};
	}
	if (def.type === 'catalog_item') {
		profile.flows = Array.from(flowCache.values());
		const withApproval = profile.flows.filter(f => f.hasApproval).map(f => f.name);
		if (withApproval.length) warnings.push(`Fulfillment flows with approval subflows or actions: ${withApproval.join(', ')}. An order waits for approval before fulfillment tasks are created.`);
	}

	// 4. Coverage and freshness.
	coverage.probes = Array.from(probeStatus.values());
	const restricted = coverage.probes.filter(p => p.status !== 'ok');
	if (restricted.length) warnings.push(`${restricted.length} probe(s) could not be read (${restricted.map(p => `${p.key}: ${p.status}`).join(', ')}); their satellites are reported as unknown.`);
	profile.freshness = await fingerprint(def, reports, safeQuery);
	return profile;
}

function sampleTimes(rows: Record<string, any>[]): ArtifactProfile['evidenceTimestamps'] {
	const times = rows.map(r => val(r.sys_updated_on)).filter(Boolean).sort();
	return { newestSampleUpdate: times[times.length - 1] || null, oldestSampleUpdate: times[0] || null };
}

type SafeCount = (key: string, table: string, query: string) => Promise<number | null>;
type SafeQuery = (key: string, table: string, query: string, fields: string[], limit: number) => Promise<Record<string, any>[] | null>;

async function provenanceFor(def: TypeDef, row: Record<string, any>, safeCount: SafeCount, safeQuery: SafeQuery): Promise<Provenance> {
	const id = val(row.sys_id);
	const createdBy = val(row.sys_created_by);
	const pkg = val(row['sys_package.name']);
	const scopeId = val(row.sys_scope);
	const created = val(row.sys_created_on);
	const signals: Provenance['signals'] = { createdBy, package: pkg || null, customerUpdates: await safeCount('provenance', 'sys_update_xml', `nameSTARTSWITH${def.rootTable}_${id}`) };
	if (createdBy === 'system') return { origin: 'platform_generated', confidence: 'high', signals };
	if (def.type === 'table' && scopeId && scopeId !== 'global' && created) {
		const sdk = await safeQuery('provenance', 'sys_module', `sys_scope=${scopeId}^nameLIKEbom.json`, ['sys_created_on'], 5);
		signals.nowSdkInstallInScope = !!sdk?.length;
		if (sdk?.some(m => val(m.sys_created_on).slice(0, 16) === created.slice(0, 16))) {
			return { origin: 'now_sdk_install', confidence: 'medium', signals };
		}
		const burst = await safeCount('provenance', 'sys_metadata', `sys_scope=${scopeId}^sys_created_by=${createdBy}^sys_created_on>=${shiftTime(created, -30)}^sys_created_on<=${shiftTime(created, 30)}`);
		signals.metadataWithin30s = burst;
		if (typeof burst === 'number' && burst >= 15) return { origin: 'automated_burst', confidence: 'low', signals };
	}
	if (typeof signals.customerUpdates === 'number' && signals.customerUpdates === 0 && pkg && !/^(global|$)/.test(pkg)) {
		return { origin: 'servicenow_plugin', confidence: 'low', signals };
	}
	if (typeof signals.customerUpdates === 'number' && signals.customerUpdates > 0) return { origin: 'customer_built', confidence: 'low', signals };
	return { origin: 'unknown', confidence: 'low', signals };
}

/** "YYYY-MM-DD HH:MM:SS" plus seconds, same format. */
export function shiftTime(stamp: string, seconds: number): string {
	const t = Date.parse(stamp.replace(' ', 'T') + 'Z');
	if (isNaN(t)) return stamp;
	return new Date(t + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

async function profileFlow(flowId: string, flowName: string, safeQuery: SafeQuery): Promise<FlowReport> {
	const report: FlowReport = { sys_id: flowId, name: flowName, subflows: [], actions: [], hasApproval: false, hasNotification: false, truncated: false, cycles: [] };
	const actionsSeen = new Set<string>();
	const edges = new Map<string, string[]>();
	const names = new Map<string, string>([[flowId, flowName]]);
	const depthOf = new Map<string, number>([[flowId, 0]]);
	// Breadth-first, so every subflow is first reached at its shortest depth and
	// the depth limit never hides a subflow that is also called closer to the
	// root, whatever order the records come back in.
	let frontier = [flowId];
	while (frontier.length) {
		const next: string[] = [];
		for (const id of frontier) {
			const depth = depthOf.get(id)!;
			const actions = (await safeQuery('flow', 'sys_hub_action_instance', `flow=${id}`, ['action_type.name'], 500)) || [];
			for (const a of actions) {
				const nm = val(a['action_type.name']);
				if (nm && !actionsSeen.has(nm)) { actionsSeen.add(nm); report.actions.push(nm); }
				if (/approv/i.test(nm)) report.hasApproval = true;
				if (/notif|email/i.test(nm)) report.hasNotification = true;
			}
			const subs = (await safeQuery('flow', 'sys_hub_sub_flow_instance', `flow=${id}`, ['subflow', 'subflow.name'], 500)) || [];
			const out: string[] = [];
			for (const sub of subs) {
				const sid = val(sub.subflow);
				const sname = val(sub['subflow.name']);
				if (!sid) continue;
				out.push(sid);
				if (sname && !names.has(sid)) names.set(sid, sname);
				if (depthOf.has(sid)) continue;
				depthOf.set(sid, depth + 1);
				if (depth + 1 < FLOW_DEPTH_MAX) next.push(sid);
				else report.truncated = true;
			}
			edges.set(id, out);
		}
		frontier = next;
	}
	// Distinct subflows with how often they are called, from the recorded calls.
	const uses = new Map<string, number>();
	for (const out of edges.values()) for (const sid of out) uses.set(sid, (uses.get(sid) || 0) + 1);
	for (const [sid, depth] of depthOf) {
		if (sid === flowId) continue;
		const name = names.get(sid) || sid;
		const approval = /approv/i.test(name);
		const notification = /notif|email/i.test(name);
		report.subflows.push({ name, sys_id: sid, depth, uses: uses.get(sid) || 0, approval, notification });
		if (approval) report.hasApproval = true;
		if (notification) report.hasNotification = true;
	}
	report.subflows.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
	// Cycles: a call back to an ancestor on some path from the root.
	const onPath = new Set<string>();
	const done = new Set<string>();
	const visit = (id: string) => {
		onPath.add(id);
		for (const sid of edges.get(id) || []) {
			if (onPath.has(sid)) { const n = names.get(sid) || sid; if (!report.cycles.includes(n)) report.cycles.push(n); }
			else if (!done.has(sid)) visit(sid);
		}
		onPath.delete(id);
		done.add(id);
	};
	visit(flowId);
	return report;
}

async function referenceFields(target: string, safeQuery: SafeQuery, coverage: Coverage): Promise<Array<{ table: string; field: string }>> {
	const rows = (await safeQuery('reference_fields', 'sys_dictionary', `reference=${target}^internal_type=reference^nameNOT LIKEv_^nameNOT LIKEts_^nameNOT LIKEvar__`, ['name', 'element'], REF_FIELDS_MAX)) || [];
	coverage.referenceFieldsScanned[target] = rows.length;
	return rows.map(r => ({ table: val(r.name), field: val(r.element) })).filter(r => r.table && r.field);
}

/**
 * A list read inside the member scan that says when it is incomplete: a
 * failed read or one that filled its row limit is recorded, never treated as
 * "nothing there".
 */
function completeReader(safeQuery: SafeQuery, notes: string[]) {
	return async (key: string, table: string, query: string, fields: string[], limit: number): Promise<Record<string, any>[]> => {
		const rows = await safeQuery(key, table, query, fields, limit);
		if (rows === null) { notes.push(`${table} could not be read`); return []; }
		if (rows.length >= limit) notes.push(`${table} returned its ${limit}-row limit; more rows may exist`);
		return rows;
	};
}

async function catalogMembers(rootId: string, safeQuery: SafeQuery, safeCount: SafeCount, coverage: Coverage): Promise<{ members: Member[]; embedded: EmbeddedRef[]; notes: string[] }> {
	const notes: string[] = [];
	const read = completeReader(safeQuery, notes);
	const members: Member[] = [{ table: 'sc_cat_item', sys_id: rootId, class: 'root', via: 'root' }];
	const embedded: EmbeddedRef[] = [];
	const own = await read('variables', 'item_option_new', `cat_item=${rootId}`, ['sys_id', 'name'], 500);
	const ownIds = new Set(own.map(v => val(v.sys_id)));
	const policies = await read('ui_policies', 'catalog_ui_policy', `catalog_item=${rootId}`, ['sys_id', 'short_description', 'catalog_conditions'], 500);
	const actions = await read('ui_policy_actions', 'catalog_ui_policy_action', `catalog_item=${rootId}`, ['sys_id', 'catalog_variable', 'ui_policy'], 500);
	const scripts = await read('client_scripts', 'catalog_script_client', `cat_item=${rootId}`, ['sys_id', 'name', 'script'], 500);
	const setLinks = await read('variable_set_links', 'io_set_item', `sc_cat_item=${rootId}`, ['sys_id', 'variable_set', 'variable_set.title'], 500);
	const setIds = setLinks.map(l => val(l.variable_set)).filter(Boolean);
	const setVars = setIds.length ? await read('variables', 'item_option_new', `variable_setIN${setIds.join(',')}`, ['sys_id', 'name', 'variable_set'], 1000) : [];
	const setVarOwner = new Map(setVars.map(v => [val(v.sys_id), val(v.variable_set)]));

	// Embedded IO:<sys_id> in this item's own policy conditions, actions and scripts.
	const scan: Array<{ table: string; field: string; rows: Record<string, any>[] }> = [
		{ table: 'catalog_ui_policy', field: 'catalog_conditions', rows: policies },
		{ table: 'catalog_ui_policy_action', field: 'catalog_variable', rows: actions },
		{ table: 'catalog_script_client', field: 'script', rows: scripts },
	];
	const unresolved: string[] = [];
	for (const { table, field, rows } of scan) {
		for (const r of rows) {
			for (const m of val(r[field]).matchAll(IO_REF)) {
				const target = m[1].toLowerCase();
				const belongsTo: EmbeddedRef['resolved']['belongsTo'] = ownIds.has(target) ? 'this_root' : setVarOwner.has(target) ? 'variable_set' : 'not_found';
				if (belongsTo === 'not_found') unresolved.push(target);
				embedded.push({ from: `${table}.${field}`, record: val(r.sys_id), pattern: 'IO:<sys_id>', target, resolved: { table: 'item_option_new', belongsTo } });
			}
		}
	}
	if (unresolved.length) {
		// Variables of another item or set: resolve which, without following them.
		const ids = Array.from(new Set(unresolved));
		const found = await read('variables', 'item_option_new', `sys_idIN${ids.join(',')}`, ['sys_id', 'cat_item', 'variable_set'], ids.length + 1);
		for (const f of found) for (const e of embedded) if (e.target === val(f.sys_id)) e.resolved.belongsTo = 'other_root';
	}

	// Who else uses this item's own variables. Configuration consumers decide,
	// counted instance-wide (no row limit): IO:<sys_id> in policy conditions,
	// policy actions and catalog client scripts that do not belong to this item.
	// A count that cannot be read makes the variable unknown, never owned.
	// Reference rows elsewhere (order answers, task variables) are data
	// references: reported, never used to classify.
	const refFields = await referenceFields('item_option_new', safeQuery, coverage);
	for (const v of own) {
		const vid = val(v.sys_id);
		let outside: number | null = 0;
		let dataRefs: number | null = 0;
		for (const rf of refFields) {
			if (rf.table === 'item_option_new') continue; // its own container fields
			const c = await safeCount('variable_users', rf.table, `${rf.field}=${vid}`);
			dataRefs = c === null || dataRefs === null ? null : dataRefs + c;
		}
		for (const p of EMBEDDED_PATTERNS) {
			const c = await safeCount('variable_users', p.table, `${p.field}LIKE${vid}^${p.rootField}!=${rootId}^OR${p.rootField}ISEMPTY`);
			outside = c === null || outside === null ? null : outside + c;
		}
		const cls: MemberClass = outside === null ? 'unknown' : outside > 0 ? 'shared' : 'owned_by_reference';
		if (outside === null) notes.push(`other users of variable ${val(v.name) || vid} could not be counted`);
		members.push({ table: 'item_option_new', sys_id: vid, name: val(v.name), class: cls, via: 'cat_item',
			...(outside !== null ? { consumers: outside } : {}), ...(dataRefs !== null ? { dataReferences: dataRefs } : {}) });
	}
	for (const p of policies) members.push({ table: 'catalog_ui_policy', sys_id: val(p.sys_id), name: val(p.short_description), class: 'owned_by_reference', via: 'catalog_item' });
	for (const a of actions) members.push({ table: 'catalog_ui_policy_action', sys_id: val(a.sys_id), class: 'owned_by_reference', via: 'catalog_item' });
	for (const sc of scripts) members.push({ table: 'catalog_script_client', sys_id: val(sc.sys_id), name: val(sc.name), class: 'owned_by_reference', via: 'cat_item' });
	for (const l of setLinks) members.push({ table: 'io_set_item', sys_id: val(l.sys_id), class: 'owned_by_reference', via: 'sc_cat_item' });

	// Variable sets: shared when more than one item links them, instance-wide.
	for (const setId of setIds) {
		const users = await safeCount('variable_set_users', 'io_set_item', `variable_set=${setId}`);
		const cls: MemberClass = users === null ? 'unknown' : users >= 2 ? 'shared' : 'no_other_use_found';
		if (users === null) notes.push(`items using variable set ${setId} could not be counted`);
		const title = val(setLinks.find(l => val(l.variable_set) === setId)?.['variable_set.title']);
		members.push({ table: 'item_option_new_set', sys_id: setId, name: title, class: cls, via: 'io_set_item.variable_set', ...(users !== null ? { consumers: users } : {}) });
		for (const sv of setVars.filter(v => val(v.variable_set) === setId)) {
			members.push({ table: 'item_option_new', sys_id: val(sv.sys_id), name: val(sv.name), class: cls === 'shared' ? 'inherits_shared' : cls, via: 'variable_set (container)' });
		}
	}

	const catalogLinks = await read('catalog_links', 'sc_cat_item_catalog', `sc_cat_item=${rootId}`, ['sys_id', 'sc_catalog'], 200);
	for (const c of catalogLinks) {
		members.push({ table: 'sc_cat_item_catalog', sys_id: val(c.sys_id), class: 'owned_by_reference', via: 'sc_cat_item' });
		if (val(c.sc_catalog)) members.push({ table: 'sc_catalog', sys_id: val(c.sc_catalog), class: 'external', via: 'sc_cat_item_catalog.sc_catalog' });
	}
	const categoryLinks = await read('category_links', 'sc_cat_item_category', `sc_cat_item=${rootId}`, ['sys_id', 'sc_category'], 200);
	for (const c of categoryLinks) {
		members.push({ table: 'sc_cat_item_category', sys_id: val(c.sys_id), class: 'owned_by_reference', via: 'sc_cat_item' });
		if (val(c.sc_category)) members.push({ table: 'sc_category', sys_id: val(c.sc_category), class: 'external', via: 'sc_cat_item_category.sc_category' });
	}
	return { members, embedded, notes };
}

async function tableMembers(name: string, safeQuery: SafeQuery, safeCount: SafeCount): Promise<{ members: Member[]; notes: string[] }> {
	const notes: string[] = [];
	const read = completeReader(safeQuery, notes);
	const members: Member[] = [];
	const acls = await read('table_acls', 'sys_security_acl', `name=${name}^ORnameSTARTSWITH${name}.`, ['sys_id', 'name', 'operation.name'], 500);
	for (const a of acls) members.push({ table: 'sys_security_acl', sys_id: val(a.sys_id), name: `${val(a.name)} ${val(a['operation.name'])}`, class: 'owned_by_reference', via: 'name' });
	const links = await read('acl_role_links', 'sys_security_acl_role', `sys_security_acl.name=${name}^ORsys_security_acl.nameSTARTSWITH${name}.`, ['sys_id', 'sys_user_role', 'sys_user_role.name'], 1000);
	const roles = new Map<string, string>();
	for (const l of links) { members.push({ table: 'sys_security_acl_role', sys_id: val(l.sys_id), class: 'owned_by_reference', via: 'sys_security_acl' }); roles.set(val(l.sys_user_role), val(l['sys_user_role.name'])); }
	for (const [rid, rname] of roles) {
		if (!rid) continue;
		const elsewhere = await safeCount('role_users', 'sys_security_acl_role', `sys_user_role=${rid}^sys_security_acl.name!=${name}^sys_security_acl.nameNOT LIKE${name}.`);
		if (elsewhere === null) notes.push(`other uses of role ${rname || rid} could not be counted`);
		members.push({ table: 'sys_user_role', sys_id: rid, name: rname, class: elsewhere === null ? 'unknown' : elsewhere > 0 ? 'shared' : 'no_other_use_found', via: 'sys_security_acl_role.sys_user_role', ...(elsewhere !== null ? { consumers: elsewhere } : {}) });
	}
	return { members, notes };
}

/** Tables whose newest change invalidates a saved profile: every satellite, plus what the type's analysis follows. */
function fingerprintTables(def: TypeDef): string[] {
	const extra = def.type === 'catalog_item'
		? ['item_option_new_set', 'sys_hub_flow', 'sys_hub_sub_flow_instance', 'sys_hub_action_instance']
		: ['sys_user_role'];
	return Array.from(new Set([...def.probes.map(p => p.table), ...extra]));
}

async function fingerprint(def: TypeDef, reports: SampleReport[], safeQuery: SafeQuery): Promise<ArtifactProfile['freshness']> {
	const fp: Record<string, string> = {};
	const ids = reports.map(r => r.sys_id);
	if (ids.length) {
		const rows = (await safeQuery('freshness', def.rootTable, `sys_idIN${ids.join(',')}^ORDERBYDESCsys_updated_on`, ['sys_updated_on'], 1)) || [];
		fp[`${def.rootTable} (samples)`] = val(rows[0]?.sys_updated_on);
	}
	for (const table of fingerprintTables(def)) {
		const rows = (await safeQuery('freshness', table, 'ORDERBYDESCsys_updated_on', ['sys_updated_on'], 1)) || [];
		fp[table] = val(rows[0]?.sys_updated_on);
	}
	return {
		fingerprint: fp,
		limitation: 'Reuse needs the same type, scope, instance, analyzer version and selection (roots, query, sample size, generated filter), and compares the newest sys_updated_on of the sampled roots, every satellite table and what the analysis follows (flows, subflows, flow actions and variable sets for catalog items; roles for tables). That is conservative (any change anywhere in those tables invalidates the profile) but blind to deletions that leave the newest timestamp unchanged, to changes in tables the profile does not read, and to ACL changes that alter what the connected user can see.',
	};
}

function selectionOf(params: ProfileParams): ArtifactProfile['selectionParams'] {
	return {
		roots: params.roots ? params.roots.slice().sort() : null,
		query: params.query || null,
		scope: params.scope || null,
		sample: params.roots ? params.roots.length : (params.sample || PROFILE_SAMPLE_DEFAULT),
		includeGenerated: params.includeGenerated === true,
		detail: params.detail === true,
	};
}

/** True when a saved profile can be reused for these params: same identity and an unchanged fingerprint. */
export function profileStillFresh(saved: any, rawParams: ProfileParams, current: Record<string, string>): { fresh: boolean; reason: string } {
	if (!saved || saved.profile !== 'snu.artifact_type_profile') return { fresh: false, reason: 'no saved profile' };
	if (saved.analyzerVersion !== ANALYZER_VERSION) return { fresh: false, reason: `analyzer version changed (${saved.analyzerVersion} -> ${ANALYZER_VERSION})` };
	let params: ProfileParams;
	try { params = validateProfileParams(rawParams); } catch { return { fresh: false, reason: 'invalid parameters' }; }
	params.instance = rawParams.instance;
	if (saved.type !== params.type || (saved.scope || null) !== (params.scope || null) || saved.instance !== params.instance) return { fresh: false, reason: 'different type, scope or instance' };
	const want = selectionOf(params);
	const had = saved.selectionParams;
	if (!had) return { fresh: false, reason: 'saved profile has no selection record' };
	for (const key of ['roots', 'query', 'scope', 'sample', 'includeGenerated'] as const) {
		if (JSON.stringify(had[key] ?? null) !== JSON.stringify(want[key] ?? null)) return { fresh: false, reason: `different ${key}` };
	}
	if (want.detail && !had.detail) return { fresh: false, reason: 'saved profile has no per-sample detail' };
	const before = saved.freshness?.fingerprint || {};
	for (const key of Object.keys({ ...before, ...current })) {
		if ((before[key] || '') !== (current[key] || '')) return { fresh: false, reason: `${key} changed since ${saved.generatedAt}` };
	}
	return { fresh: true, reason: 'fingerprint unchanged' };
}

/** Recompute only the fingerprint, for a reuse check. */
export async function currentFingerprint(io: ProfileIO, saved: any): Promise<Record<string, string>> {
	const fp: Record<string, string> = {};
	const def = TYPES[saved?.type as ArtifactType];
	if (!def) return fp;
	const ids: string[] = (saved.sampleReports || []).map((r: any) => r.sys_id).filter((s: any) => typeof s === 'string' && SYS_ID.test(s));
	if (ids.length) {
		const rows = await io.query(def.rootTable, `sys_idIN${ids.join(',')}^ORDERBYDESCsys_updated_on`, ['sys_updated_on'], 1);
		fp[`${def.rootTable} (samples)`] = val(rows[0]?.sys_updated_on);
	}
	for (const table of fingerprintTables(def)) {
		const rows = await io.query(table, 'ORDERBYDESCsys_updated_on', ['sys_updated_on'], 1);
		fp[table] = val(rows[0]?.sys_updated_on);
	}
	return fp;
}
