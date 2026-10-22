/**
 * Conformance vectors for query validation.
 *
 * queryValidation.ts is mirrored into the `snu` CLI rather than shared
 * (separate builds), so both test suites run this same table against the same
 * offline schema. The schema is a trimmed copy of dev436517's
 * /api/now/ui/meta answers (2026-10-22); `question` really has no cat_item.
 *
 * Keep this file free of imports: it is copied verbatim into packages/snu.
 */

const ref = (reference: string) => ({ type: 'reference', reference });
const text = { type: 'string' };

/** Table -> columns; a table mapped to null cannot be read (ACL, unknown table). */
export const VECTOR_SCHEMA: Record<string, Record<string, any> | null> = {
	question_choice: { sys_id: { type: 'GUID' }, question: ref('question'), text: { type: 'translated_field' }, value: text, order: { type: 'integer' }, inactive: { type: 'boolean' } },
	question: { sys_id: { type: 'GUID' }, name: text, question_text: text, sys_class_name: { type: 'sys_class_name' }, order: { type: 'integer' } },
	item_option_new: { sys_id: { type: 'GUID' }, name: text, question_text: text, cat_item: ref('sc_cat_item'), variable_set: ref('item_option_new_set') },
	sc_cat_item: { sys_id: { type: 'GUID' }, name: text, category: ref('sc_category'), active: { type: 'boolean' } },
	incident: {
		sys_id: { type: 'GUID' }, number: text, short_description: text, priority: { type: 'integer' }, state: { type: 'integer' },
		caller_id: ref('sys_user'), opened_by: ref('sys_user'), assignment_group: ref('sys_user_group'), sys_created_on: { type: 'glide_date_time' },
		sys_updated_on: { type: 'glide_date_time' }, watch_list: { type: 'glide_list' }, cmdb_ci: ref('cmdb_ci'),
	},
	sys_user: { sys_id: { type: 'GUID' }, name: text, user_name: text, manager: ref('sys_user'), department: ref('cmn_department') },
	sys_user_group: { sys_id: { type: 'GUID' }, name: text, manager: ref('sys_user') },
	cmn_department: null,
	cmdb_ci: { sys_id: { type: 'GUID' }, name: text },
	cmdb_ci_server: { sys_id: { type: 'GUID' }, name: text, os: text },
};

export interface QueryValidationVector {
	name: string;
	table: string;
	params: { query?: string; fields?: string; orderBy?: string };
	/** 'ok': the query may run. Otherwise exactly these problems, in order; each listed field must match. */
	expect: 'ok' | Array<{ code: 'E_INVALID_QUERY' | 'E_QUERY_UNVERIFIABLE'; source: 'query' | 'fields' | 'orderBy'; path?: string; hop?: string; table?: string }>;
}

export const QUERY_VALIDATION_VECTORS: QueryValidationVector[] = [
	{
		name: 'the 2026-10-22 query: question has no cat_item',
		table: 'question_choice',
		params: { query: 'question.cat_item=73da21de97085f14c3e2fc90f053aff3', fields: 'question.name,text,value,order,inactive' },
		expect: [{ code: 'E_INVALID_QUERY', source: 'query', path: 'question.cat_item', hop: 'cat_item', table: 'question' }],
	},
	{
		name: 'a ref_ cast reaches the field on the extending table',
		table: 'question_choice',
		params: { query: 'question.ref_item_option_new.cat_item=73da21de97085f14c3e2fc90f053aff3' },
		expect: 'ok',
	},
	{
		name: 'OR and NQ branches, dot-walks and fields are all checked',
		table: 'incident',
		params: { query: 'active=true^priority=1^ORcaller_id.manager.name=Fred^NQassignment_group.name=Network', fields: 'number,caller_id.user_name,sys_id' },
		expect: [{ code: 'E_INVALID_QUERY', source: 'query', path: 'active', hop: 'active', table: 'incident' }],
	},
	{
		name: 'operators of every family on valid fields',
		table: 'incident',
		params: { query: 'priorityIN1,2^short_descriptionLIKEprinter^stateNOT IN6,7^cmdb_ciISEMPTY^caller_idDYNAMIC90d1921e5f510100a9ad2572f2b477fe^numberSTARTSWITHINC^EQ', orderBy: 'ORDERBYDESCsys_created_on' },
		expect: 'ok',
	},
	{
		name: 'script values are not judged once the field is valid',
		table: 'incident',
		params: { query: 'opened_by=javascript:gs.getUserID()^sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()' },
		expect: 'ok',
	},
	{
		name: 'a script value on a broken field is still invalid',
		table: 'incident',
		params: { query: 'opend_by=javascript:gs.getUserID()' },
		expect: [{ code: 'E_INVALID_QUERY', source: 'query', path: 'opend_by' }],
	},
	{
		name: 'the field inside ORDERBY is checked',
		table: 'incident',
		params: { query: 'priority=1^ORDERBYcaller_id.nmae' },
		expect: [{ code: 'E_INVALID_QUERY', source: 'query', path: 'caller_id.nmae', hop: 'nmae', table: 'sys_user' }],
	},
	{
		name: 'the field before DYNAMIC is checked',
		table: 'incident',
		params: { query: 'calller_idDYNAMIC90d1921e5f510100a9ad2572f2b477fe^cmdb_ciISEMPTY' },
		expect: [{ code: 'E_INVALID_QUERY', source: 'query', path: 'calller_id', hop: 'calller_id' }],
	},
	{
		name: 'a bare orderBy field is checked as an order field',
		table: 'incident',
		params: { orderBy: 'sys_created_onn' },
		expect: [{ code: 'E_INVALID_QUERY', source: 'orderBy', path: 'sys_created_onn' }],
	},
	{
		name: 'a bad entry in fields',
		table: 'incident',
		params: { fields: 'number,short_desc' },
		expect: [{ code: 'E_INVALID_QUERY', source: 'fields', path: 'short_desc' }],
	},
	{
		name: 'dot-walking a non-reference field is invalid',
		table: 'incident',
		params: { query: 'short_description.name=x^watch_list.name=y' },
		expect: [
			{ code: 'E_INVALID_QUERY', source: 'query', path: 'short_description.name', table: 'incident' },
			{ code: 'E_INVALID_QUERY', source: 'query', path: 'watch_list.name', table: 'incident' },
		],
	},
	{
		name: 'a field-valued operand is checked like a field',
		table: 'incident',
		params: { query: 'opened_bySAMEAScaller_idd' },
		expect: [{ code: 'E_INVALID_QUERY', source: 'query', path: 'caller_idd' }],
	},
	{
		name: 'an unknown operator leaves the field boundary unproven',
		table: 'incident',
		params: { query: 'priorityWHATEVER3' },
		expect: [{ code: 'E_QUERY_UNVERIFIABLE', source: 'query' }],
	},
	{
		name: 'a condition that does not start with a field name',
		table: 'incident',
		params: { query: 'GOTOnumber>=INC0010001' },
		expect: [{ code: 'E_QUERY_UNVERIFIABLE', source: 'query' }],
	},
	{
		name: 'columns that cannot be read are no proof either way',
		table: 'incident',
		params: { query: 'caller_id.department.name=IT' },
		expect: [{ code: 'E_QUERY_UNVERIFIABLE', source: 'query', path: 'caller_id.department.name', table: 'cmn_department' }],
	},
	{
		name: 'an invalid path outranks an unverifiable one, both are listed',
		table: 'incident',
		params: { query: 'caller_id.department.name=IT^nmuber=1' },
		expect: [
			{ code: 'E_QUERY_UNVERIFIABLE', source: 'query', path: 'caller_id.department.name' },
			{ code: 'E_INVALID_QUERY', source: 'query', path: 'nmuber' },
		],
	},
	{
		name: 'keyword search and related-list blocks are supported constructs',
		table: 'incident',
		params: { query: '123TEXTQUERY321=printer^RLQUERYtask_sla.task,>=1^stage=breached^ENDRLQUERY^priority=1' },
		expect: 'ok',
	},
	{
		name: 'an escaped caret stays inside the value',
		table: 'incident',
		params: { query: 'short_description=a^^b^priority=1' },
		expect: 'ok',
	},
	{
		name: 'empty parameters',
		table: 'incident',
		params: {},
		expect: 'ok',
	},
];
