import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher, resolveMappedFileName } from '../server/dispatcher.js';

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snu-browsersave-'));
}

async function withBridge(
  cwd: string,
  fn: (ctx: { ws: WebSocket; received: any[] }) => Promise<void>
): Promise<void> {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const dispatcher = new StandaloneDispatcher({ cwd, wsBridge, pending });
  wsBridge.onSaveFieldAsFile = (msg) => {
    void dispatcher.handleBrowserFieldSave(msg);
  };

  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const received: any[] = [];
  ws.on('message', (raw) => {
    try { received.push(JSON.parse(raw.toString('utf8'))); } catch {}
  });
  await new Promise<void>((resolve) => ws.on('open', resolve));
  await new Promise((r) => setTimeout(r, 50));

  try {
    await fn({ ws, received });
  } finally {
    try { ws.close(); } catch {}
    await wsBridge.close();
  }
}

function savePayload(overrides: Record<string, any> = {}): any {
  return {
    action: 'saveFieldAsFile',
    instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'tok' },
    table: 'sys_script_include',
    field: 'script',
    fieldType: 'script',
    sys_id: 'abcdef0123456789abcdef0123456789',
    scope: 'global',
    name: 'TestScript01',
    content: 'var x = 1;',
    ...overrides,
  };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('BrowserSave: saveFieldAsFile push writes the file, _map.json, and echoes contentLength', async () => {
  const cwd = makeTempWorkspace();
  await withBridge(cwd, async ({ ws, received }) => {
    ws.send(JSON.stringify(savePayload()));

    const filePath = path.join(cwd, 'dev123', 'global', 'sys_script_include', 'TestScript01.script.js');
    await waitFor(() => fs.existsSync(filePath));

    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'var x = 1;');
    const map = JSON.parse(fs.readFileSync(path.join(cwd, 'dev123', 'global', 'sys_script_include', '_map.json'), 'utf8'));
    assert.deepStrictEqual(map, { TestScript01: 'abcdef0123456789abcdef0123456789' });

    await waitFor(() => received.some((m) => 'contentLength' in m));
    const echo = received.find((m) => 'contentLength' in m);
    assert.ok(echo, 'expected a success echo with contentLength');
    assert.strictEqual(echo.contentLength, 'var x = 1;'.length);
    assert.strictEqual(echo.send, false);
  });
});

test('BrowserSave: a record renamed on the instance keeps its stable local file name', async () => {
  const cwd = makeTempWorkspace();
  await withBridge(cwd, async ({ ws, received }) => {
    ws.send(JSON.stringify(savePayload()));
    const filePath = path.join(cwd, 'dev123', 'global', 'sys_script_include', 'TestScript01.script.js');
    await waitFor(() => fs.existsSync(filePath));

    ws.send(JSON.stringify(savePayload({ name: 'TestScript02', content: 'var x = 2;' })));
    await waitFor(() => received.filter((m) => 'contentLength' in m).length >= 2);

    // Same file updated, no second file, map key unchanged.
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'var x = 2;');
    assert.strictEqual(
      fs.existsSync(path.join(cwd, 'dev123', 'global', 'sys_script_include', 'TestScript02.script.js')),
      false
    );
    const map = JSON.parse(fs.readFileSync(path.join(cwd, 'dev123', 'global', 'sys_script_include', '_map.json'), 'utf8'));
    assert.deepStrictEqual(map, { TestScript01: 'abcdef0123456789abcdef0123456789' });
  });
});

test('BrowserSave: scope sys_id is resolved via the helper and cached in scopes.json', async () => {
  const cwd = makeTempWorkspace();
  await withBridge(cwd, async ({ ws, received }) => {
    // Answer the daemon's sys_scope lookup like the helper tab would.
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.action === 'agentRestApi' && msg.agentRequestId) {
          ws.send(JSON.stringify({
            agentRequestId: msg.agentRequestId,
            success: true,
            data: { result: { scope: 'x_myapp' } },
          }));
        }
      } catch {}
    });

    ws.send(JSON.stringify(savePayload({ scope: '11112222333344445555666677778888' })));

    const filePath = path.join(cwd, 'dev123', 'x_myapp', 'sys_script_include', 'TestScript01.script.js');
    await waitFor(() => fs.existsSync(filePath));
    assert.ok(fs.existsSync(filePath), 'expected file under the resolved scope folder');

    const scopes = JSON.parse(fs.readFileSync(path.join(cwd, 'dev123', 'scopes.json'), 'utf8'));
    assert.strictEqual(scopes.x_myapp, '11112222333344445555666677778888');
    await waitFor(() => received.some((m) => 'contentLength' in m));
    assert.ok(received.some((m) => 'contentLength' in m));
  });
});

test('BrowserSave: unsafe path components are refused with an error echo', async () => {
  const cwd = makeTempWorkspace();
  await withBridge(cwd, async ({ ws, received }) => {
    ws.send(JSON.stringify(savePayload({ table: '../escape' })));
    await waitFor(() => received.some((m) => typeof m.error === 'string'));
    assert.ok(received.some((m) => typeof m.error === 'string'), 'expected an error echo');
    assert.strictEqual(fs.existsSync(path.join(cwd, 'dev123')), false);
  });
});

test('BrowserSave: resolveMappedFileName reports renames and suffixes collisions', () => {
  const cwd = makeTempWorkspace();
  const mapPath = path.join(cwd, '_map.json');
  fs.writeFileSync(mapPath, JSON.stringify({ TestScript01: 'aa0000000000000000000000000000aa' }), 'utf8');

  const renamed = resolveMappedFileName(mapPath, 'TestScript02', 'aa0000000000000000000000000000aa');
  assert.strictEqual(renamed.cleanName, 'TestScript01');
  assert.strictEqual(renamed.renamedTo, 'TestScript02');

  const collision = resolveMappedFileName(mapPath, 'TestScript01', 'bb1111111111111111111111111111cc');
  assert.strictEqual(collision.cleanName, 'TestScript01-BBCC');
  assert.strictEqual(collision.map['TestScript01-BBCC'], 'bb1111111111111111111111111111cc');
});
