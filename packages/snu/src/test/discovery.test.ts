import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import {
  findWorkspacePortFile,
  discoverBridge,
  ScriptSyncClientError,
  MIN_API_VERSION,
} from '../client.js';

test('Discovery: finds .vscode/sn-agent-port.json in ancestor directories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-test-'));
  try {
    const vscodeDir = path.join(tmpDir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    const portFile = path.join(vscodeDir, 'sn-agent-port.json');
    fs.writeFileSync(portFile, JSON.stringify({ port: 1977, token: 'secret', pid: process.pid }));

    const subDir = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(subDir, { recursive: true });

    const found = findWorkspacePortFile(subDir);
    assert.strictEqual(found, portFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Discovery: rejects port file with PID mismatch (stale port file)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-test-'));
  let server: http.Server | undefined;
  try {
    // Start mock health server on ephemeral port
    server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', apiVersion: 7, pid: 99999, commands: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    const portFile = path.join(tmpDir, 'sn-agent-port.json');
    fs.writeFileSync(portFile, JSON.stringify({ port, token: 'secret', pid: 11111 }));

    await assert.rejects(
      () => discoverBridge({ portFile }),
      (err: any) => {
        assert.ok(err instanceof ScriptSyncClientError);
        assert.strictEqual(err.code, 'E_STALE_PORT_FILE');
        return true;
      }
    );
  } finally {
    if (server) server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Discovery: reports error when port file does not exist', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-empty-'));
  try {
    const nonExistent = path.join(tmpDir, 'non-existent-port.json');
    await assert.rejects(
      () => discoverBridge({ portFile: nonExistent }),
      (err: any) => {
        assert.ok(err instanceof ScriptSyncClientError);
        assert.strictEqual(err.code, 'E_PORT_FILE_NOT_FOUND');
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
