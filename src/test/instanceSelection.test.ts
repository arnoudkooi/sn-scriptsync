import test from 'node:test';
import assert from 'node:assert';
import { selectKnownInstance } from '../agent/instanceSelection';

const known = [
	{ name: 'dev1', url: 'https://dev1.service-now.com', folder: '/workspace/dev1' },
	{ name: 'dev2', url: 'https://dev2.service-now.com', folder: '/workspace/dev2' },
	{ name: 'dev3', url: 'https://dev3.service-now.com', folder: '/workspace/dev3' },
];

test('auth instance selection prefers the one helper-observed workspace instance', () => {
	const selected = selectKnownInstance(known, [{ name: 'dev2', url: 'https://dev2.service-now.com/' }]);
	assert.strictEqual(selected.kind, 'single');
	if (selected.kind === 'single') assert.strictEqual(selected.instance.name, 'dev2');
});

test('remembered workspace instances are not reported as live instances', () => {
	const selected = selectKnownInstance(known, []);
	assert.strictEqual(selected.kind, 'multiple-known');
	if (selected.kind === 'multiple-known') {
		assert.deepStrictEqual(selected.instances.map((instance) => instance.name), ['dev1', 'dev2', 'dev3']);
	}
});

test('multiple helper-observed instances remain ambiguous', () => {
	const selected = selectKnownInstance(known, [
		{ name: 'dev1', url: 'https://dev1.service-now.com' },
		{ name: 'dev3', url: 'https://dev3.service-now.com' },
	]);
	assert.strictEqual(selected.kind, 'multiple-live');
	if (selected.kind === 'multiple-live') {
		assert.deepStrictEqual(selected.instances.map((instance) => instance.name), ['dev1', 'dev3']);
	}
});
