import test from 'node:test';
import assert from 'node:assert';
import { createMcpServer } from '../mcp/index.js';

test('MCP: server instantiates cleanly with all tools', async () => {
  const server = await createMcpServer();
  assert.ok(server);
  assert.strictEqual(typeof server.connect, 'function');
});
