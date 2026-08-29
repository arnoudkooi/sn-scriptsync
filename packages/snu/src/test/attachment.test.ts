import test from 'node:test';
import assert from 'node:assert';
import { resolveBridgeAttachment } from '../cli/attachment.js';
import { HealthResponse } from '../types.js';

function health(over: Partial<HealthResponse> = {}): HealthResponse {
  return { status: 'success', apiVersion: 9, commands: [], pid: 4242, ...over };
}

const noDiscovery = async () => { throw Object.assign(new Error('none'), { code: 'E_BRIDGE_NOT_FOUND' }); };
const nothingHealthy = async () => undefined;

test('a discoverable bridge is attached to, never replaced', async () => {
  const result = await resolveBridgeAttachment({
    discover: async () => ({ port: 1977, pid: 42 }),
    probeHealth: nothingHealthy,
  });
  assert.strictEqual(result.mode, 'attached-discovered');
  assert.strictEqual(result.mayReclaimPorts, false);
});

test('a serving bridge with a missing descriptor is attached to, not clobbered', async () => {
  // The multi-MCP-client failure: discovery fails because the port file was
  // removed, but a healthy bridge is running and must survive.
  const result = await resolveBridgeAttachment({
    discover: noDiscovery,
    probeHealth: async (port) => (port === 1977 ? health({ hostKind: 'standalone', pid: 777 }) : undefined),
  });
  assert.strictEqual(result.mode, 'attached-undiscoverable');
  assert.strictEqual(result.pid, 777);
  assert.strictEqual(result.mayReclaimPorts, false, 'a serving bridge must never be reclaimable');
  assert.match(result.reason, /not replaced/);
});

test('an editor-hosted bridge with a stale descriptor is attached to as well', async () => {
  const result = await resolveBridgeAttachment({
    discover: async () => { throw Object.assign(new Error('stale'), { code: 'E_STALE_PORT_FILE' }); },
    probeHealth: async () => health({ hostKind: 'vscode', pid: 5907 }),
  });
  assert.strictEqual(result.mode, 'attached-undiscoverable');
  assert.strictEqual(result.hostKind, 'vscode');
  assert.strictEqual(result.mayReclaimPorts, false);
});

test('only when nothing answers may ports be reclaimed', async () => {
  const result = await resolveBridgeAttachment({
    discover: noDiscovery,
    probeHealth: nothingHealthy,
  });
  assert.strictEqual(result.mode, 'create-standalone');
  assert.strictEqual(result.mayReclaimPorts, true);
});

test('every candidate port is tried before giving up', async () => {
  const probed: number[] = [];
  const result = await resolveBridgeAttachment({
    discover: noDiscovery,
    probeHealth: async (port) => { probed.push(port); return port === 1999 ? health() : undefined; },
    candidatePorts: [1977, 1998, 1999],
  });
  assert.deepStrictEqual(probed, [1977, 1998, 1999]);
  assert.strictEqual(result.mode, 'attached-undiscoverable');
  assert.strictEqual(result.port, 1999);
});

test('the outcome always explains itself for the startup log', async () => {
  for (const probe of [nothingHealthy, async () => health()]) {
    const result = await resolveBridgeAttachment({ discover: noDiscovery, probeHealth: probe });
    assert.ok(result.reason.length > 0);
  }
});
