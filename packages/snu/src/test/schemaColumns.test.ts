import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { enrichSchemaColumns, uiMetaColumns } from '../server/schemaColumns.js';
import { formatHumanOutput } from '../cli/format.js';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { PendingRegistry } from '../server/pendingRegistry.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';

// The four keys every column had in Steve's `snu schema --json` output (0.6.5).
const DOC = [
  { label: 'Access bundle', internalType: 'reference', exampleValue: '9666e0c3c611227c017f673bcebef646', name: 'template' },
  { label: 'Approval decided', internalType: 'glide_date_time', exampleValue: '2014-11-12 04:51:19', name: 'approval_decided_at' },
  { label: 'Origin', internalType: 'choice', exampleValue: '', name: 'origin' },
  { label: 'Requested for', internalType: 'reference', exampleValue: '9666e0c3c611227c017f673bcebef646', name: 'requested_for' },
];
// Shape of /api/now/ui/meta/<table> as captured live on 2026-11-15.
const META = { result: { columns: {
  template: { name: 'template', label: 'Access bundle', type: 'reference', internal_type: 'reference', reference: 'x_acme_bundle', mandatory: true, read_only: false, max_length: 32 },
  approval_decided_at: { name: 'approval_decided_at', label: 'Approval decided', internal_type: 'glide_date_time', mandatory: false, read_only: true, max_length: 40 },
  origin: { name: 'origin', label: 'Origin', type: 'choice', internal_type: 'string', mandatory: false, read_only: false, max_length: 40, default: 'portal',
    choices: [{ label: '-- None --', value: '' }, { label: 'Portal', value: 'portal' }, { label: 'Phone', value: 'phone' }] },
  requested_for: { name: 'requested_for', label: 'Requested for', internal_type: 'reference', reference: 'sys_user', mandatory: false, read_only: false, max_length: 32 },
  sys_scope: { name: 'sys_scope', label: 'Application', internal_type: 'reference', reference: 'sys_scope', mandatory: false, read_only: false, max_length: 32 },
} } };

test('schema: documentation keys stay, metadata adds flags, references and inherited columns', () => {
  const columns = enrichSchemaColumns(DOC, META);
  assert.equal(columns.length, 5);
  assert.deepEqual(columns[0], { ...DOC[0], type: 'reference', reference: 'x_acme_bundle', mandatory: true, readOnly: false, maxLength: 32 });
  assert.deepEqual(columns[2], { ...DOC[2], type: 'choice', mandatory: false, readOnly: false, maxLength: 40, defaultValue: 'portal', choiceCount: 2 });
  assert.equal(columns[4].name, 'sys_scope');
  assert.equal(columns[4].reference, 'sys_scope');
  assert.equal(columns[4].exampleValue, undefined);
  const withChoices = enrichSchemaColumns(DOC, META, { choices: true });
  assert.deepEqual(withChoices[2].choices, [{ value: 'portal', label: 'Portal' }, { value: 'phone', label: 'Phone' }]);
});

test('schema: without metadata a flag is left out (unknown), never reported as false', () => {
  const columns = enrichSchemaColumns(DOC, undefined);
  assert.deepEqual(columns[0], { ...DOC[0], type: 'reference' });
  for (const c of columns) {
    assert.equal('mandatory' in c, false);
    assert.equal('reference' in c, false);
  }
  assert.deepEqual(uiMetaColumns(null), {});
  assert.deepEqual(uiMetaColumns({ result: { columns: [] } }), {});
});

test('schema: readable output fills Type and shows ? for what the instance did not report', () => {
  const out = formatHumanOutput('get_table_metadata', enrichSchemaColumns(DOC, undefined)).replace(/\x1b\[[0-9;]*m/g, '');
  const template = out.split('\n').find(l => l.startsWith('template'))!;
  assert.match(template, /template\s+Access bundle\s+reference\s+\?\s+\?\s+\?\s+\?/);
  assert.doesNotMatch(out, /\bNo\b/);
  assert.match(out, /\? = not reported by the instance \(unknown\)/);
  assert.match(out, /generated sample from the API documentation, not record data/);

  const full = formatHumanOutput('get_table_metadata', enrichSchemaColumns(DOC, META)).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(full.split('\n').find(l => l.startsWith('template'))!, /reference\s+32\s+Yes\s+No\s+x_acme_bundle/);
  assert.match(full.split('\n').find(l => l.startsWith('origin'))!, /choice\s+40\s+No\s+No\s*$/);
  assert.doesNotMatch(full, /not reported by the instance/);
});

test('schema: the VS Code host shape ({ columns map, fields }) prints the same table', () => {
  const out = formatHumanOutput('get_table_metadata', { columns: META.result.columns }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /Schema Dictionary \(5 columns\)/);
  assert.match(out, /requested_for\s+Requested for\s+reference\s+32\s+No\s+No\s+sys_user/);
});

async function withBridge(onRest: (request: any, reply: (payload: any) => void) => void, body: (d: StandaloneDispatcher) => Promise<void>) {
  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-schema-'));
  const dispatcher = new StandaloneDispatcher({ cwd: tmpDir, wsBridge, pending, cliFlags: {} } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  try {
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ instance: { name: 'dev123', url: 'https://dev123.service-now.com', g_ck: 'tok' } }));
    await new Promise((r) => setTimeout(r, 20));
    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.action !== 'agentRestApi') return;
      onRest(request, (payload) => ws.send(JSON.stringify({ agentRequestId: request.agentRequestId, ...payload })));
    });
    await body(dispatcher);
  } finally {
    ws.close();
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('schema: the standalone bridge merges both reads and survives either one failing', async () => {
  for (const mode of ['both', 'meta_fails', 'doc_fails', 'both_fail'] as const) {
    const endpoints: string[] = [];
    await withBridge((request, reply) => {
      endpoints.push(request.endpoint);
      const isDoc = request.endpoint.startsWith('/api/now/doc/table/schema/');
      const fails = mode === 'both_fail' || (isDoc ? mode === 'doc_fails' : mode === 'meta_fails');
      if (fails) return reply({ success: false, status: 500, error: isDoc ? 'doc unavailable' : 'meta unavailable' });
      reply({ success: true, status: 200, data: isDoc ? { result: DOC } : META });
    }, async (dispatcher) => {
      const response: any = await dispatcher.dispatch({ id: 's', command: 'get_table_metadata', params: { table: 'x_acme_line' } });
      assert.deepEqual(endpoints.sort(), ['/api/now/doc/table/schema/x_acme_line', '/api/now/ui/meta/x_acme_line']);
      if (mode === 'both_fail') {
        assert.equal(response.status, 'error');
        assert.equal(response.code, 'E_NOT_FOUND');
        assert.match(response.error, /doc unavailable/);
        return;
      }
      assert.equal(response.status, 'success', JSON.stringify(response));
      const byName = Object.fromEntries(response.result.map((c: any) => [c.name, c]));
      assert.equal(byName.template.type, 'reference');
      if (mode !== 'doc_fails') assert.equal(byName.template.exampleValue, DOC[0].exampleValue);
      if (mode === 'meta_fails') assert.equal('mandatory' in byName.template, false);
      else assert.equal(byName.template.reference, 'x_acme_bundle');
    });
  }
});

test('schema: a malformed table name is refused before any request', async () => {
  await withBridge(() => assert.fail('must not reach the browser'), async (dispatcher) => {
    const response: any = await dispatcher.dispatch({ id: 'bad', command: 'get_table_metadata', params: { table: '../sys_user' } });
    assert.equal(response.code, 'E_INVALID_PARAMS');
  });
});

test('schema: --choices values and labels are listed under the readable table', () => {
  const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
  const out = strip(formatHumanOutput('get_table_metadata', enrichSchemaColumns(DOC, META, { choices: true })));
  assert.match(out, /Choices:\n  origin\n    portal  Portal\n    phone  Phone/);
  assert.doesNotMatch(strip(formatHumanOutput('get_table_metadata', enrichSchemaColumns(DOC, META))), /Choices:/, 'only when requested');
});

test('context: readable output shows the usage setting and bridge warnings', () => {
  const out = formatHumanOutput('get_context', {
    bridgeReady: true, browserConnected: true, serviceNowReady: true, helper: { tier: 'pro', proFeatures: true },
    usage: { collection: 'on', sharingPreference: 'off' },
    warnings: ['This folder is inside a git repository (/work/app). Pulled instance scripts are written here.'],
  }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /Usage Data:\s+collection on, sharing preference off/);
  assert.match(out, /! This folder is inside a git repository/);
});
