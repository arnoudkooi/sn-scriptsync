import test from 'node:test';
import assert from 'node:assert';
import { canonicalJson, computePayloadHash } from '../server/canonical.js';

test('Canonical: deterministic key sorting across nested objects and arrays', () => {
  const obj1 = { z: 1, a: { y: 2, b: 3 }, arr: [{ d: 4, c: 5 }] };
  const obj2 = { a: { b: 3, y: 2 }, z: 1, arr: [{ c: 5, d: 4 }] };

  assert.strictEqual(canonicalJson(obj1), canonicalJson(obj2));
  assert.strictEqual(
    canonicalJson(obj1),
    '{"a":{"b":3,"y":2},"arr":[{"c":5,"d":4}],"z":1}'
  );
});

test('Canonical: computePayloadHash produces identical SHA-256 for equivalent payloads', () => {
  const hash1 = computePayloadHash(1, 'https://ven08329.service-now.com', 'run_background_script', {
    script: "gs.print('hi');",
    timeout: 30,
  });

  const hash2 = computePayloadHash(1, 'https://VEN08329.service-now.com/', 'run_background_script', {
    timeout: 30,
    script: "gs.print('hi');",
  });

  assert.strictEqual(hash1, hash2);
  assert.strictEqual(typeof hash1, 'string');
  assert.strictEqual(hash1.length, 64);
});
