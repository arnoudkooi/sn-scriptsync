import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { quoteShellArg } from './shell-quote.mjs';

test('POSIX browser arguments survive shell parsing literally', { skip: process.platform === 'win32' }, () => {
  const args = [
    '', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '--profile-directory=Profile 1', 'backslash\\"quote', 'trailing\\',
    '$(printf INJECTED)', '`printf INJECTED`', '$HOME', 'a; echo INJECTED',
    "single'quote", 'a&b|c<d>e', 'line\nbreak',
  ];
  const command = [process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...args]
    .map((arg) => quoteShellArg(arg, 'linux')).join(' ');
  const output = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), args);
});

test('Windows browser arguments preserve paths and refuse shell expansion', () => {
  assert.equal(quoteShellArg('C:\\Program Files\\Chrome\\chrome.exe', 'win32'), '"C:\\Program Files\\Chrome\\chrome.exe"');
  assert.equal(quoteShellArg('--profile-directory=Profile 1', 'win32'), '"--profile-directory=Profile 1"');
  assert.equal(quoteShellArg('trailing\\', 'win32'), '"trailing\\\\"');
  for (const value of ['a"b', '%TEMP%', '!TEMP!', 'a\nb', 'a\rb']) {
    assert.throws(() => quoteShellArg(value, 'win32'), /Cannot safely quote/);
  }
  for (const platform of ['linux', 'win32']) {
    assert.throws(() => quoteShellArg('a\0b', platform), /NUL/);
  }
});
