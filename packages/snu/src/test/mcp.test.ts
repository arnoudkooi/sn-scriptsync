import test from 'node:test';
import assert from 'node:assert';
import { createMcpServer } from '../mcp/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOLS } from '../registry.js';
import { VERSION } from '../version.js';
import { ScriptSyncClient, ScriptSyncClientError } from '../client.js';

test('MCP: server instantiates cleanly with all tools', async () => {
  const server = await createMcpServer();
  assert.ok(server);
  assert.strictEqual(typeof server.connect, 'function');
});

test('MCP publishes every registry tool and the 0.4 input schemas', async t => {
  const server = await createMcpServer();
  const client = new Client({ name: 'parity-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.deepStrictEqual(tools.map(tool => tool.name).sort(), TOOLS.map(tool => tool.name).sort());
  assert.strictEqual(client.getServerVersion()?.version, VERSION);
  const artifact = tools.find(tool => tool.name === 'snu_create_artifact')!;
  assert.ok(artifact.inputSchema.properties?.fieldsFile);
  const batch = tools.find(tool => tool.name === 'snu_update_record_batch')!;
  assert.ok(batch.inputSchema.properties?.fieldsFile);
  assert.deepStrictEqual(batch.inputSchema.required, ['table', 'sys_id']);
  const instructions = client.getInstructions() || '';
  assert.ok(instructions.includes('snu_get_review_result'));
  assert.ok(instructions.includes('Never repeat the original write'));

  // Exercise MCP wrapping without connecting to any user's live bridge.
  const calls: any[] = [];
  const original = ScriptSyncClient.prototype.execute;
  (ScriptSyncClient.prototype as any).execute = async (mapped: any) => {
    calls.push(mapped);
    if (mapped.command === 'run_background_script') {
      throw new ScriptSyncClientError('Approval required', 'E_REVIEW_PENDING', 202, { reviewId: 'review-test' });
    }
    return { result: { reviewId: mapped.params.reviewId, output: 'done' } };
  };
  t.after(() => { ScriptSyncClient.prototype.execute = original; });
  const pending = await client.callTool({ name: 'snu_run_background_script', arguments: { script: 'gs.info(1);' } });
  assert.ok(!pending.isError);
  const details = JSON.parse((pending.content as any[])[0].text);
  assert.strictEqual(details.status, 'pending');
  assert.strictEqual(details.reviewId, 'review-test');
  const result = await client.callTool({ name: 'snu_get_review_result', arguments: { reviewId: details.reviewId, waitSeconds: 0 } });
  assert.strictEqual(JSON.parse((result.content as any[])[0].text).output, 'done');
  assert.deepStrictEqual(calls.map(call => call.command), ['run_background_script', 'get_review_result']);
});
