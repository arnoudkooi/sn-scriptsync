import test from 'node:test';
import assert from 'node:assert/strict';
import { columnsFromMeta, createSchemaCache, queryValidationError, validateQuery } from '../agent/queryValidation';
import { QUERY_VALIDATION_VECTORS, VECTOR_PARENTS, VECTOR_SCHEMA } from '../agent/queryValidationVectors';

const lookup = async (table: string) => (table in VECTOR_SCHEMA ? VECTOR_SCHEMA[table] : {});
const parentOf = async (table: string) => (table in VECTOR_PARENTS ? VECTOR_PARENTS[table] : null);

for (const vector of QUERY_VALIDATION_VECTORS) {
	test(`query validation: ${vector.name}`, async () => {
		const problems = await validateQuery(vector.table, vector.params, lookup, parentOf);
		const expected = vector.expect === 'ok' ? [] : vector.expect;
		assert.equal(problems.length, expected.length, JSON.stringify(problems));
		expected.forEach((want, i) => {
			for (const [key, value] of Object.entries(want)) assert.equal((problems[i] as any)[key], value, `problem ${i}.${key}: ${JSON.stringify(problems[i])}`);
		});
	});
}

test('a lookup that throws is no proof: the query is unverifiable', async () => {
	const problems = await validateQuery('incident', { query: 'priority=1' }, async () => { throw new Error('network'); });
	assert.deepEqual(problems.map((p) => p.code), ['E_QUERY_UNVERIFIABLE']);
});

test('the error: an invalid path outranks an unverifiable one; no problems, no error', () => {
	assert.equal(queryValidationError([]), null);
	const error = queryValidationError([
		{ code: 'E_QUERY_UNVERIFIABLE', source: 'query', condition: 'a.b=1', reason: 'the columns of x could not be read' },
		{ code: 'E_INVALID_QUERY', source: 'fields', condition: 'nmuber', path: 'nmuber', reason: 'incident has no field "nmuber"' },
	])!;
	assert.equal(error.code, 'E_INVALID_QUERY');
	assert.match(error.message, /incident has no field "nmuber" in "nmuber" \(fields\)/);
	assert.match(error.message, /validate: false/);
	assert.equal(error.details.problems.length, 2);
});

test('the schema cache keeps readable tables for its TTL and asks again for failed ones', async () => {
	let clock = 0;
	const calls: string[] = [];
	const cached = createSchemaCache(1000, () => clock);
	const fetch = async (table: string) => { calls.push(table); return table === 'gone' ? null : { sys_id: { type: 'GUID' } }; };
	await cached('incident', fetch); await cached('incident', fetch); await cached('gone', fetch); await cached('gone', fetch);
	assert.deepEqual(calls, ['incident', 'gone', 'gone']);
	clock = 1500;
	await cached('incident', fetch);
	assert.deepEqual(calls, ['incident', 'gone', 'gone', 'incident']);
});

test('columns are read out of a ui/meta answer; anything else is unreadable', () => {
	assert.deepEqual(columnsFromMeta({ result: { columns: { a: { type: 'string' } } } }), { a: { type: 'string' } });
	assert.equal(columnsFromMeta({ result: {} }), null);
	assert.equal(columnsFromMeta('<html>'), null);
});
