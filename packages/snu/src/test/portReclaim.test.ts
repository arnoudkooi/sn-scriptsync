import test from 'node:test';
import assert from 'node:assert';
import {
  classifyListener,
  findPortListener,
  terminateListener,
  reclaimPort,
  ExecImpl,
} from '../cli/portReclaim.js';

test('classifyListener: recognizes snu bridge command lines', () => {
  assert.strictEqual(
    classifyListener('node /Users/me/.npm/_npx/e3f5e663/node_modules/.bin/snu --mcp'),
    'snu'
  );
  assert.strictEqual(
    classifyListener('node /usr/local/lib/node_modules/@snutils/snu/bin/snu.js serve'),
    'snu'
  );
  assert.strictEqual(
    classifyListener('node /Users/me/dev/sn-scriptsync/packages/snu/bin/snu.js --mcp'),
    'snu'
  );
  assert.strictEqual(classifyListener('snu serve --ws 1978'), 'snu');
});

test('classifyListener: recognizes VS Code extension hosts', () => {
  assert.strictEqual(
    classifyListener('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=extensionHost'),
    'vscode'
  );
  assert.strictEqual(classifyListener('/usr/share/code/code --type=extensionHost'), 'vscode');
  assert.strictEqual(classifyListener('Cursor Helper (Plugin) --type=extensionHost'), 'vscode');
});

test('classifyListener: anything else is unknown', () => {
  assert.strictEqual(classifyListener('python3 -m http.server 1978'), 'unknown');
  assert.strictEqual(classifyListener(''), 'unknown');
  // A random node app is not assumed to be ours.
  assert.strictEqual(classifyListener('node /Users/me/app/server.js'), 'unknown');
});

test('findPortListener: parses lsof + ps output (posix)', async () => {
  const calls: string[][] = [];
  const exec: ExecImpl = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'lsof') return { stdout: 'p74024\nf12\n' };
    if (file === 'ps') return { stdout: 'node /x/.bin/snu --mcp\n' };
    throw new Error(`unexpected ${file}`);
  };
  const listener = await findPortListener(1978, exec, 'darwin');
  assert.deepStrictEqual(listener, { pid: 74024, command: 'node /x/.bin/snu --mcp' });
  assert.strictEqual(calls[0][0], 'lsof');
});

test('findPortListener: returns null when nothing listens or lsof is missing', async () => {
  const emptyExec: ExecImpl = async () => ({ stdout: '' });
  assert.strictEqual(await findPortListener(1978, emptyExec, 'darwin'), null);
  const failingExec: ExecImpl = async () => {
    throw new Error('lsof: command not found');
  };
  assert.strictEqual(await findPortListener(1978, failingExec, 'linux'), null);
});

test('findPortListener: parses netstat output (windows)', async () => {
  const exec: ExecImpl = async (file) => {
    if (file === 'netstat') {
      return {
        stdout: [
          '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1104',
          '  TCP    127.0.0.1:1978         0.0.0.0:0              LISTENING       4242',
        ].join('\r\n'),
      };
    }
    if (file === 'powershell') return { stdout: 'node C:\\x\\.bin\\snu --mcp\r\n' };
    throw new Error(`unexpected ${file}`);
  };
  const listener = await findPortListener(1978, exec, 'win32');
  assert.deepStrictEqual(listener, { pid: 4242, command: 'node C:\\x\\.bin\\snu --mcp' });
});

test('terminateListener: SIGTERM suffices when the port frees up', async () => {
  const signals: string[] = [];
  let free = false;
  const ok = await terminateListener(4242, 1978, {
    killImpl: (_pid, sig) => {
      signals.push(sig);
      free = true; // process exits on SIGTERM
    },
    portFreeImpl: async () => free,
    delayMs: 1,
  });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(signals, ['SIGTERM']);
});

test('terminateListener: escalates to SIGKILL when SIGTERM is ignored', async () => {
  const signals: string[] = [];
  let free = false;
  const ok = await terminateListener(4242, 1978, {
    killImpl: (_pid, sig) => {
      signals.push(sig);
      if (sig === 'SIGKILL') free = true;
    },
    portFreeImpl: async () => free,
    delayMs: 1,
  });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('reclaimPort: free port is a no-op', async () => {
  const result = await reclaimPort(1978, { findImpl: async () => null });
  assert.deepStrictEqual(result, { status: 'free' });
});

test('reclaimPort: stops an orphaned snu bridge', async () => {
  let terminated = 0;
  const result = await reclaimPort(1978, {
    findImpl: async () => ({ pid: 74024, command: 'node /x/.bin/snu --mcp' }),
    terminateImpl: async () => {
      terminated++;
      return true;
    },
  });
  assert.strictEqual(result.status, 'reclaimed');
  assert.strictEqual(terminated, 1);
});

test('reclaimPort: never touches a VS Code host, even with force', async () => {
  const result = await reclaimPort(1978, {
    force: true,
    findImpl: async () => ({ pid: 111, command: 'Code Helper (Plugin) --type=extensionHost' }),
    terminateImpl: async () => {
      throw new Error('must not be called');
    },
  });
  assert.strictEqual(result.status, 'refused_vscode');
});

test('reclaimPort: refuses a foreign process unless forced', async () => {
  const findImpl = async () => ({ pid: 222, command: 'python3 -m http.server 1978' });
  const refused = await reclaimPort(1978, { findImpl, terminateImpl: async () => true });
  assert.strictEqual(refused.status, 'refused_foreign');
  const forced = await reclaimPort(1978, { force: true, findImpl, terminateImpl: async () => true });
  assert.strictEqual(forced.status, 'reclaimed');
});

test('reclaimPort: reports failure when the holder will not die', async () => {
  const result = await reclaimPort(1978, {
    findImpl: async () => ({ pid: 74024, command: 'snu serve' }),
    terminateImpl: async () => false,
  });
  assert.strictEqual(result.status, 'failed');
});
