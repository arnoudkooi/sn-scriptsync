/**
 * Conformance vectors for multi-record writes.
 *
 * bulkWrite.ts is mirrored into the `snu` CLI rather than shared (separate
 * builds), so both test suites run this same table. A behaviour change in one
 * host that is not made in the other fails there.
 *
 * Keep this file free of imports: it is copied verbatim into packages/snu.
 */

const A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const B = 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const APP = 'c1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const OTHER_APP = 'd1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

export interface BulkValidateVector {
	name: string;
	mode: 'create' | 'update';
	params: any;
	expect:
		| { ok: true; rows: number; continueOnError?: boolean; dryRun?: boolean; deadlineMs?: number; pinnedScopes?: string[]; firstSysId?: string }
		| { ok: false; messageIncludes: string };
}

export const BULK_VALIDATE_VECTORS: BulkValidateVector[] = [
	{ name: 'create with defaults', mode: 'create', params: { table: 'sys_choice', rows: [{ label: 'a' }, { label: 'b' }] },
		expect: { ok: true, rows: 2, continueOnError: false, dryRun: false, deadlineMs: 600_000, pinnedScopes: [] } },
	{ name: 'missing table', mode: 'create', params: { rows: [{ a: 1 }] }, expect: { ok: false, messageIncludes: '"table"' } },
	{ name: 'table with a dot is refused', mode: 'create', params: { table: 'sys.choice', rows: [{ a: 1 }] }, expect: { ok: false, messageIncludes: '"table"' } },
	{ name: 'empty rows', mode: 'create', params: { table: 't', rows: [] }, expect: { ok: false, messageIncludes: '"rows"' } },
	{ name: 'row cap', mode: 'create', params: { table: 't', rows: Array.from({ length: 201 }, () => ({ a: 1 })) }, expect: { ok: false, messageIncludes: 'limit is 200' } },
	{ name: 'payload cap', mode: 'create', params: { table: 't', rows: [{ script: 'x'.repeat(1_000_001) }] }, expect: { ok: false, messageIncludes: 'bytes of JSON' } },
	{ name: 'a row that is not an object names its index', mode: 'create', params: { table: 't', rows: [{ a: 1 }, 'x'] }, expect: { ok: false, messageIncludes: 'Row 1' } },
	{ name: 'an empty row', mode: 'create', params: { table: 't', rows: [{}] }, expect: { ok: false, messageIncludes: 'no fields' } },
	{ name: 'invalid field name', mode: 'create', params: { table: 't', rows: [{ 'a.b': 1 }] }, expect: { ok: false, messageIncludes: 'invalid field name' } },
	{ name: 'create may pin a sys_id', mode: 'create', params: { table: 't', rows: [{ sys_id: A.toUpperCase(), a: 1 }] }, expect: { ok: true, rows: 1, firstSysId: A } },
	{ name: 'duplicate sys_id', mode: 'update', params: { table: 't', rows: [{ sys_id: A, a: 1 }, { sys_id: A, a: 2 }] }, expect: { ok: false, messageIncludes: 'repeats sys_id' } },
	{ name: 'update needs sys_id', mode: 'update', params: { table: 't', rows: [{ a: 1 }] }, expect: { ok: false, messageIncludes: 'no sys_id' } },
	{ name: 'update with only a sys_id has nothing to write', mode: 'update', params: { table: 't', rows: [{ sys_id: A }] }, expect: { ok: false, messageIncludes: 'no fields' } },
	{ name: 'create with only a sys_id inserts an empty record', mode: 'create', params: { table: 't', rows: [{ sys_id: A }] }, expect: { ok: true, rows: 1, firstSysId: A } },
	{ name: 'update rejects sys_scope (stricter than update_record_batch)', mode: 'update', params: { table: 't', rows: [{ sys_id: A, sys_scope: APP }] }, expect: { ok: false, messageIncludes: 'read-only after insert' } },
	{ name: 'update takes no batch scope', mode: 'update', params: { table: 't', scope: 'x_app', rows: [{ sys_id: A, a: 1 }] }, expect: { ok: false, messageIncludes: 'no "scope"' } },
	{ name: 'create row sys_scope must be a sys_id or global', mode: 'create', params: { table: 't', rows: [{ sys_scope: 'x_app', a: 1 }] }, expect: { ok: false, messageIncludes: 'fields.sys_scope' } },
	{ name: 'create rows report their pinned scopes once', mode: 'create', params: { table: 't', rows: [{ sys_scope: APP.toUpperCase(), a: 1 }, { sys_scope: APP, a: 2 }] }, expect: { ok: true, rows: 2, pinnedScopes: [APP] } },
	{ name: 'continueOnError and dryRun', mode: 'update', params: { table: 't', continueOnError: true, dryRun: true, rows: [{ sys_id: A, a: 1 }, { sys_id: B, a: 2 }] }, expect: { ok: true, rows: 2, continueOnError: true, dryRun: true } },
	{ name: 'continueOnError must be boolean', mode: 'create', params: { table: 't', continueOnError: 'yes', rows: [{ a: 1 }] }, expect: { ok: false, messageIncludes: 'continueOnError' } },
	{ name: 'deadline bounds', mode: 'create', params: { table: 't', deadlineMinutes: 31, rows: [{ a: 1 }] }, expect: { ok: false, messageIncludes: 'deadlineMinutes' } },
	{ name: 'deadline override', mode: 'create', params: { table: 't', deadlineMinutes: 2, rows: [{ a: 1 }] }, expect: { ok: true, rows: 1, deadlineMs: 120_000 } },
];

export interface BulkScopeVector {
	name: string;
	batch?: { specified: boolean; sysScopeId?: string; effectiveScope?: string };
	pinned: string[];
	expect: { ok: true; transactionScope?: string; effectiveScope?: string } | { ok: false };
}

export const BULK_SCOPE_VECTORS: BulkScopeVector[] = [
	{ name: 'nothing stated: the session decides', pinned: [], expect: { ok: true } },
	{ name: 'batch scope by name resolves to its sys_id', batch: { specified: true, sysScopeId: APP, effectiveScope: 'x_app' }, pinned: [], expect: { ok: true, transactionScope: APP, effectiveScope: 'x_app' } },
	{ name: 'batch name and row sys_id of the same app agree', batch: { specified: true, sysScopeId: APP.toUpperCase(), effectiveScope: 'x_app' }, pinned: [APP], expect: { ok: true, transactionScope: APP, effectiveScope: 'x_app' } },
	{ name: 'rows alone set the scope', pinned: [APP], expect: { ok: true, transactionScope: APP, effectiveScope: APP } },
	{ name: 'batch and row name different apps', batch: { specified: true, sysScopeId: APP }, pinned: [OTHER_APP], expect: { ok: false } },
	{ name: 'rows name different apps', pinned: [APP, OTHER_APP], expect: { ok: false } },
	{ name: 'global on purpose sends no transaction scope', batch: { specified: true, effectiveScope: 'global' }, pinned: ['global'], expect: { ok: true, effectiveScope: 'global' } },
	{ name: 'global batch with an app row conflicts', batch: { specified: true, effectiveScope: 'global' }, pinned: [APP], expect: { ok: false } },
];

type O = 'succeeded' | 'failed' | 'not_attempted' | 'unknown';

export interface BulkSummaryVector {
	name: string;
	outcomes: O[];
	notRunCode?: string;
	expect: { status: 'success' | 'error'; code?: string };
}

export const BULK_SUMMARY_VECTORS: BulkSummaryVector[] = [
	{ name: 'all succeeded', outcomes: ['succeeded', 'succeeded'], expect: { status: 'success' } },
	{ name: 'some succeeded', outcomes: ['succeeded', 'failed', 'not_attempted'], expect: { status: 'error', code: 'E_PARTIAL_FAILURE' } },
	{ name: 'some succeeded, one unknown', outcomes: ['succeeded', 'unknown'], expect: { status: 'error', code: 'E_PARTIAL_FAILURE' } },
	{ name: 'all failed', outcomes: ['failed', 'failed'], expect: { status: 'error', code: 'E_COMMAND_FAILED' } },
	{ name: 'failed, then not attempted', outcomes: ['failed', 'not_attempted', 'not_attempted'], expect: { status: 'error', code: 'E_COMMAND_FAILED' } },
	{ name: 'unknown with no success', outcomes: ['failed', 'unknown', 'not_attempted'], expect: { status: 'error', code: 'E_TIMEOUT' } },
	{ name: 'all unknown', outcomes: ['unknown'], expect: { status: 'error', code: 'E_TIMEOUT' } },
	{ name: 'nothing attempted takes the cause', outcomes: ['not_attempted', 'not_attempted'], notRunCode: 'E_USER_REJECTED', expect: { status: 'error', code: 'E_USER_REJECTED' } },
];

export interface BulkFieldKindVector {
	name: string;
	columns: any;
	fields: string[];
	expect: Record<string, string>;
}

export const BULK_FIELD_KIND_VECTORS: BulkFieldKindVector[] = [
	{
		name: 'column types map to compare rules',
		columns: {
			work_notes: { internal_type: 'journal_input' }, comments: { internal_type: 'journal_input' },
			u_secret: { internal_type: 'password2' }, u_token: { internal_type: 'glide_encrypted' },
			active: { internal_type: 'boolean' }, impact: { type: 'choice', internal_type: 'integer' },
			u_amount: { internal_type: 'decimal' }, watch_list: { internal_type: 'glide_list' },
			caller_id: { internal_type: 'reference' }, short_description: { internal_type: 'string' },
			business_duration: { internal_type: 'glide_duration' },
		},
		fields: ['work_notes', 'comments', 'u_secret', 'u_token', 'active', 'impact', 'u_amount', 'watch_list', 'caller_id', 'short_description', 'business_duration', 'u_unknown'],
		expect: {
			work_notes: 'skip', comments: 'skip', u_secret: 'skip', u_token: 'skip', active: 'bool', impact: 'number',
			u_amount: 'number', watch_list: 'list', caller_id: 'text', short_description: 'text', business_duration: 'skip',
		},
	},
	{ name: 'no metadata, no rules', columns: null, fields: ['a'], expect: {} },
];
