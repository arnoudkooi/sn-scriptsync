import test from 'node:test';
import assert from 'node:assert';
import { buildDoctorReport, formatDoctorReport, safeCommand, DoctorSources } from '../cli/doctor.js';

const TOKEN = 'deadbeefcafebabe0123456789abcdef';
const SESSION = 'JSESSIONID=ABCDEF0123456789';

/** Every field a real collector could fill, stuffed with secrets. */
function sources(over: Partial<DoctorSources> = {}): DoctorSources {
  return {
    cliVersion: '0.2.4',
    platform: 'darwin',
    nodeVersion: 'v22.0.0',
    cwd: '/tmp/ws',
    descriptors: [
      {
        path: '~/.sn-scriptsync/agent-port.json',
        data: { port: 1977, pid: 5907, token: TOKEN, hostKind: 'vscode', workspaceRoot: '/tmp/ws' },
      },
    ],
    health: {
      status: 'success',
      apiVersion: 9,
      hostKind: 'vscode',
      pid: 5907,
      extensionVersion: '4.8.8',
      workspaceRoot: '/tmp/ws',
      commands: ['a', 'b'],
      // A field a future bridge might add. A blocklist would pass it through.
      internalAuthHeader: `Bearer ${TOKEN}`,
    },
    listeners: [{ port: 1977, pid: 5907, command: `node bridge --token ${TOKEN}`, kind: 'vscode' }],
    lease: { pid: 5907, editorKind: 'cursor', workspaceRoot: '/tmp/ws', lastHeartbeatAt: 1000, token: TOKEN },
    instances: [{ name: 'ven08329', url: `https://ven08329.service-now.com/nav_to.do?${SESSION}`, hasSettings: true }],
    auth: [{ instance: 'ven08329', state: 'AUTH_OK', ok: true, lastValidatedAt: 1000 }],
    capabilities: { tier: 'pro', proFeatures: true, capabilities: { commandReview: 1 }, sessionToken: TOKEN },
    recentErrors: [`start failed: token=${TOKEN}`],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Redaction. The allowlist means an unnamed field cannot reach the report even
// when the collector hands one over — which is the failure mode a blocklist has.
// ---------------------------------------------------------------------------

test('no secret reaches the report, from any source field', () => {
  const serialised = JSON.stringify(buildDoctorReport(sources()));
  assert.ok(!serialised.includes(TOKEN), 'a token must never appear');
  assert.ok(!serialised.includes(SESSION), 'session material must never appear');
  assert.ok(!serialised.includes('Bearer'), 'an unmodelled auth field must be dropped, not copied');
  assert.ok(!serialised.includes('sessionToken'), 'unknown capability fields must be dropped');
});

test('the human summary leaks nothing either', () => {
  const text = formatDoctorReport(buildDoctorReport(sources()));
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(SESSION));
});

test('a token is reported as present, never as a value', () => {
  const report = buildDoctorReport(sources());
  assert.strictEqual(report.descriptors[0].carriesToken, true);
  assert.ok(!JSON.stringify(report.descriptors[0]).includes(TOKEN));
});

test('instance URLs are reduced to an origin', () => {
  const report = buildDoctorReport(sources());
  assert.strictEqual(report.instances[0].origin, 'https://ven08329.service-now.com');
});

test('credentials passed on a command line are scrubbed', () => {
  assert.ok(!safeCommand(`node x --token ${TOKEN}`).includes(TOKEN));
  assert.ok(!safeCommand(`node x --password hunter2`).includes('hunter2'));
  assert.ok(safeCommand('node bridge --port 1977').includes('--port 1977'), 'harmless args survive');
});

test('a long command line is truncated rather than dumped', () => {
  assert.ok(safeCommand('x'.repeat(500)).length <= 120);
});

// ---------------------------------------------------------------------------
// Findings. A dump that leaves the diagnosis to the reader is not a diagnostic.
// ---------------------------------------------------------------------------

test('a healthy bridge reports no problems', () => {
  const report = buildDoctorReport(sources());
  assert.match(report.findings.join(' '), /No problems found/);
});

test('a stale descriptor is named with both PIDs', () => {
  const report = buildDoctorReport(sources({
    descriptors: [{ path: 'p', data: { pid: 111, port: 1977, token: TOKEN } }],
  }));
  assert.match(report.findings.join(' '), /names PID 111.*PID 5907.*stale/s);
});

test('a healthy bridge with no descriptor is called undiscoverable', () => {
  const report = buildDoctorReport(sources({ descriptors: [] }));
  assert.match(report.findings.join(' '), /undiscoverable/);
});

test('a port held by something that is not serving is called out as takeable', () => {
  const report = buildDoctorReport(sources({ health: undefined }));
  const text = report.findings.join(' ');
  assert.match(text, /No bridge answered/);
  assert.match(text, /alive but not answering/);
});

test('two workspaces claiming the bridge is surfaced', () => {
  const report = buildDoctorReport(sources({
    lease: { pid: 5907, editorKind: 'cursor', workspaceRoot: '/tmp/other', lastHeartbeatAt: 1 },
  }));
  assert.match(report.findings.join(' '), /More than one workspace claims the bridge/);
});

test('an expired session names the instance and the fix', () => {
  const report = buildDoctorReport(sources({
    auth: [{ instance: 'ven08329', state: 'AUTH_EXPIRED', ok: false }],
  }));
  assert.match(report.findings.join(' '), /rejected the session for ven08329.*\/token/s);
});

test('ownership disagreeing with reality is surfaced', () => {
  const report = buildDoctorReport(sources({
    lease: { pid: 42, editorKind: 'code', workspaceRoot: '/tmp/ws', lastHeartbeatAt: 1 },
  }));
  assert.match(report.findings.join(' '), /ownership and reality disagree/);
});

// ---------------------------------------------------------------------------
// Found by running the diagnostic on a live machine: four of six instances were
// not OK and the summary still read "the session checks passed". A summary that
// claims more than it knows is the exact defect this tool exists to catch.
// ---------------------------------------------------------------------------

test('an unverifiable session is not silently counted as passing', () => {
  const report = buildDoctorReport(sources({
    auth: [
      { instance: 'ven08329', state: 'AUTH_OK', ok: true },
      { instance: 'snutils', state: 'AUTH_UNKNOWN', ok: false },
    ],
  }));
  const text = report.findings.join(' ');
  assert.match(text, /could not be verified for snutils/);
  assert.ok(!/No problems found/.test(text), 'an unresolved probe is not "no problems"');
});

test('a never-connected instance is reported as expected, not as a failure', () => {
  const report = buildDoctorReport(sources({
    auth: [{ instance: 'empakooi', state: 'AUTH_MISSING', ok: false }],
  }));
  const text = report.findings.join(' ');
  assert.match(text, /No session yet for empakooi/);
  assert.match(text, /expected until/);
});

test('the all-clear states how many sessions were actually verified', () => {
  const report = buildDoctorReport(sources({
    auth: [
      { instance: 'a', state: 'AUTH_OK', ok: true },
      { instance: 'b', state: 'AUTH_OK', ok: true },
    ],
  }));
  assert.match(report.findings.join(' '), /all 2 instance sessions verified/);
});

test('an all-clear with no sessions checked says so rather than implying they passed', () => {
  const report = buildDoctorReport(sources({ auth: [] }));
  assert.match(report.findings.join(' '), /No instance sessions were checked/);
});
