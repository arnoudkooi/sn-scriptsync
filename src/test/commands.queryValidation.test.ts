import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createHarness } from './helpers/commandHarness';
import { VECTOR_PARENTS, VECTOR_SCHEMA } from '../agent/queryValidationVectors';

const harness = createHarness();
// Install the vscode stub before loading the command module.
const { queryCommands } = require('../agent/commands/query');
const query = queryCommands.find((c: any) => c.name === 'query_records');

test.beforeEach(() => { harness.sent.length = 0; });
test.after(() => harness.cleanup());

/** Answer every browser request by what it asks for, instead of a fixed queue. */
function instanceAt(url: string, records: any[] = [{ sys_id: '1' }], pagination?: any) {
	fs.writeFileSync(path.join(harness.instanceFolder, '_settings.json'), JSON.stringify({ name: 'testinst', url, g_ck: 'token' }));
	return harness.context({
		waitForBrowserResponse: async () => {
			// The handler registers the wait before it sends; answer once the message is out.
			await new Promise((resolve) => setImmediate(resolve));
			const message = harness.sent.at(-1)!;
			if (message.action === 'agentQueryRecords') return { success: true, tableName: message.tableName, count: records.length, records, ...(pagination !== undefined ? { pagination } : {}) };
			if (message.endpoint === '/api/now/table/sys_db_object') {
				const name = String(message.queryParams.sysparm_query).replace('name=', '');
				const parent = VECTOR_PARENTS[name];
				return parent === null || parent === undefined ? { success: false, status: 403, error: 'ACL' }
					: { success: true, status: 200, data: { result: [{ 'super_class.name': parent }] } };
			}
			const table = String(message.endpoint).split('/').pop()!;
			const columns = VECTOR_SCHEMA[table];
			return columns === null ? { success: false, status: 403, error: 'ACL' } : { success: true, status: 200, data: { result: { columns: columns || {} } } };
		},
	});
}

test('query_records: an invalid dot-walk fails with E_INVALID_QUERY and the query is not run', async () => {
	await assert.rejects(query.handle(instanceAt('https://one.service-now.com'), { table: 'question_choice', query: 'question.cat_item=73da21de97085f14c3e2fc90f053aff3', fields: 'text,value' }),
		(error: any) => error.code === 'E_INVALID_QUERY' && error.details.problems[0].hop === 'cat_item' && /not run/.test(error.message));
	assert.deepEqual(harness.sent.map((m) => m.action === 'agentQueryRecords' ? 'query' : m.endpoint),
		['/api/now/ui/meta/question_choice', '/api/now/ui/meta/question']);
});

test('query_records: a valid query returns the unchanged result; columns are cached per instance', async () => {
	const ctx = instanceAt('https://two.service-now.com');
	const first = await query.handle(ctx, { table: 'incident', query: 'priority=1^opened_by=javascript:gs.getUserID()', fields: 'number,caller_id.name' });
	assert.deepEqual(first, { table: 'incident', count: 1, records: [{ sys_id: '1' }], limit: 10, more: false, defaultLimit: true });
	harness.sent.length = 0;
	await query.handle(ctx, { table: 'incident', query: 'priority=2' });
	assert.deepEqual(harness.sent.map((m) => m.action), ['agentQueryRecords']);
});

test('query_records: unreadable columns are no proof: E_QUERY_UNVERIFIABLE, unless validate is false', async () => {
	const ctx = instanceAt('https://three.service-now.com');
	await assert.rejects(query.handle(ctx, { table: 'cmn_department', query: 'name=IT' }), { code: 'E_QUERY_UNVERIFIABLE' });
	harness.sent.length = 0;
	const result = await query.handle(ctx, { table: 'cmn_department', query: 'name=IT', validate: false });
	assert.equal(result.count, 1);
	assert.deepEqual(harness.sent.map((m) => m.action), ['agentQueryRecords']);
});

test('query_records: the default field list is not validated', async () => {
	const result = await query.handle(instanceAt('https://four.service-now.com'), { table: 'question', query: 'name=x' });
	assert.equal(result.count, 1);
});

test('query_records: a ref_ cast is proven through the table hierarchy before the query runs', async () => {
	const result = await query.handle(instanceAt('https://five.service-now.com'), { table: 'question_choice', query: 'question.ref_item_option_new.cat_item=73da21de97085f14c3e2fc90f053aff3' });
	assert.equal(result.count, 1);
	assert.ok(harness.sent.some((m) => m.endpoint === '/api/now/table/sys_db_object' && m.queryParams.sysparm_query === 'name=item_option_new'));
	await assert.rejects(query.handle(instanceAt('https://five.service-now.com'), { table: 'incident', query: 'caller_id.ref_incident.priority=1' }), { code: 'E_INVALID_QUERY' });
});

test('query_records: the helper\'s total count reaches the result; a missing count is never invented', async () => {
	const two = [{ sys_id: '1' }, { sys_id: '2' }];
	const counted = await query.handle(instanceAt('https://six.service-now.com', two, { link: '<https://six.service-now.com/api/now/table/incident?sysparm_offset=2>;rel="next"', totalCount: '42' }),
		{ table: 'incident', query: 'active=true', fields: 'number', limit: 2, validate: false });
	assert.equal(counted.total, 42);
	assert.equal(counted.more, true);
	assert.match(counted.note, /Showing 2 of 42 matching records/);

	for (const pagination of [{ link: null, totalCount: null }, undefined]) {
		const atLimit = await query.handle(instanceAt('https://six.service-now.com', two, pagination), { table: 'incident', query: 'active=true', fields: 'number', limit: 2, validate: false });
		assert.equal('total' in atLimit, false);
		assert.equal(atLimit.more, true, 'reaching the limit still says more may match');
		assert.match(atLimit.note, /The limit of 2 was reached/);
		const below = await query.handle(instanceAt('https://six.service-now.com', two, pagination), { table: 'incident', query: 'active=true', fields: 'number', limit: 5, validate: false });
		assert.equal('total' in below, false);
		assert.equal(below.more, false);
	}
});
