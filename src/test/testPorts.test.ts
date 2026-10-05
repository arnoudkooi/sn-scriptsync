import test from 'node:test';
import assert from 'node:assert';
import { parseTestPorts } from '../agent/testPorts';

/**
 * The save-path harness runs a second bridge next to the user's own. Its port
 * override must never land on the real ports or accept junk.
 */

test('test ports: a valid pair moves both ports', () => {
  assert.deepStrictEqual(parseTestPorts('21977,21978'), { agent: 21977, browser: 21978 });
  assert.deepStrictEqual(parseTestPorts(' 31000 , 31001 '), { agent: 31000, browser: 31001 });
});

test('test ports: unset or malformed means the normal ports', () => {
  for (const value of [undefined, '', '21977', '21977,', 'a,b', '21977;21978', '21977,21978,21979']) {
    assert.strictEqual(parseTestPorts(value), null, String(value));
  }
});

test('test ports: never the real ports, privileged ports or one port twice', () => {
  for (const value of ['1977,21978', '21977,1978', '80,21978', '21977,70000', '21977,21977']) {
    assert.strictEqual(parseTestPorts(value), null, value);
  }
});
