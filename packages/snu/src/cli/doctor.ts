/**
 * `snu doctor` — one bundle that explains why the bridge is not behaving,
 * without leaking anything.
 *
 * Two rules shape this file.
 *
 * Redaction is an ALLOWLIST. Every field in the report is named here
 * explicitly; anything not named is dropped. A blocklist would be the obvious
 * design and the wrong one: the port descriptor carries an auth token, health
 * responses may grow fields, and instance settings hold session material — with
 * a blocklist, every future field leaks by default and the mistake is invisible
 * until someone pastes a diagnostic into an issue. Here the failure mode is a
 * missing field, which is loud and harmless.
 *
 * Collection is INJECTED. The report shape and the redaction are pure, so they
 * can be tested against token-shaped fixtures without a bridge, processes or
 * a network.
 */

export interface DoctorSources {
	cliVersion: string;
	/** Raw descriptor contents, keyed by the path they came from. */
	descriptors: Array<{ path: string; data: any | null; error?: string }>;
	/** Raw /api/health response, if any bridge answered. */
	health?: any;
	/** Processes listening on the bridge ports. */
	listeners: Array<{ port: number; pid: number; command: string; kind: string } | null>;
	/** Owner lease contents, if present. */
	lease?: any;
	/** Instance folders discovered in the workspace. */
	instances: Array<{ name: string; url?: string | null; hasSettings: boolean }>;
	/** auth_status results per instance, if the bridge could be asked. */
	auth?: Array<{ instance: string; state?: string; ok?: boolean; lastValidatedAt?: number }>;
	/** get_capabilities result, if reachable. */
	capabilities?: any;
	/** Recent lifecycle/bridge errors, newest last. */
	recentErrors?: string[];
	platform: string;
	nodeVersion: string;
	cwd: string;
}

export interface DoctorReport {
	generatedAt: number | null;
	versions: {
		cli: string;
		extension: string | null;
		bridgeApi: number | null;
		node: string;
		platform: string;
	};
	bridge: {
		reachable: boolean;
		hostKind: string | null;
		pid: number | null;
		workspaceRoot: string | null;
		startedAt: number | null;
		commandCount: number | null;
	};
	ownership: {
		leasePresent: boolean;
		leasePid: number | null;
		leaseEditorKind: string | null;
		leaseWorkspaceRoot: string | null;
		leaseHeartbeatAt: number | null;
	};
	descriptors: Array<{
		path: string;
		present: boolean;
		pid: number | null;
		port: number | null;
		hostKind: string | null;
		workspaceRoot: string | null;
		/** Whether a credential field was present — never its value. */
		carriesToken: boolean;
		error?: string;
	}>;
	listeners: Array<{ port: number; pid: number; kind: string; command: string }>;
	instances: Array<{ name: string; origin: string | null; hasSettings: boolean }>;
	auth: Array<{ instance: string; state: string; ok: boolean; lastValidatedAt: number | null }>;
	capabilities: { tier: string | null; proFeatures: boolean | null; commandReview: boolean | null } | null;
	findings: string[];
	recentErrors: string[];
}

/** Origin only: a full instance URL can carry a path, query or session hints. */
function toOrigin(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

function asNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

/**
 * Scrub free text — command lines and error messages.
 *
 * This is the one place an allowlist cannot be used: the content is arbitrary
 * strings produced elsewhere, so there are no fields to enumerate. Treat it as
 * defence in depth rather than a guarantee, and keep the surface small by
 * truncating hard.
 *
 * Three shapes are removed: credential-ish key/value pairs with or without
 * leading dashes, bearer tokens, and any long hex or base64-looking run, which
 * is what this codebase's 32-character tokens actually look like. The first
 * version of this only matched dashed flags, and the redaction test caught a
 * token in `token=<value>` sailing straight through.
 */
export function scrubFreeText(value: unknown, max = 120): string {
	const text = typeof value === 'string' ? value : '';
	const scrubbed = text
		.replace(/((?:--?)?(?:token|password|passwd|secret|key|pat|authorization|cookie|g_ck|jsessionid)(?:\s*[=:]\s*|\s+))\S+/gi, '$1<redacted>')
		.replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
		.replace(/\b[A-Fa-f0-9]{24,}\b/g, '<redacted>')
		.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '<redacted>');
	return scrubbed.length > max ? `${scrubbed.slice(0, max - 3)}...` : scrubbed;
}

/** Back-compat alias: command lines are just one kind of free text. */
export const safeCommand = scrubFreeText;

/**
 * Build the report. Every output field is constructed explicitly from a named
 * input; nothing is spread, copied wholesale, or passed through.
 */
export function buildDoctorReport(sources: DoctorSources, now: number | null = null): DoctorReport {
	const health = sources.health || null;

	const descriptors = sources.descriptors.map((entry) => {
		const data = entry.data;
		return {
			path: entry.path,
			present: !!data,
			pid: asNumber(data?.pid),
			port: asNumber(data?.port),
			hostKind: asString(data?.hostKind),
			workspaceRoot: asString(data?.workspaceRoot),
			// The token's PRESENCE is diagnostic; its value never is.
			carriesToken: typeof data?.token === 'string' && data.token.length > 0,
			...(entry.error ? { error: entry.error } : {}),
		};
	});

	const listeners = sources.listeners
		.filter((l): l is NonNullable<typeof l> => !!l)
		.map((l) => ({ port: l.port, pid: l.pid, kind: l.kind, command: scrubFreeText(l.command) }));

	const instances = sources.instances.map((i) => ({
		name: i.name,
		origin: toOrigin(i.url),
		hasSettings: i.hasSettings,
	}));

	const auth = (sources.auth || []).map((a) => ({
		instance: a.instance,
		state: asString(a.state) || 'AUTH_UNKNOWN',
		ok: a.ok === true,
		lastValidatedAt: asNumber(a.lastValidatedAt),
	}));

	const capabilities = sources.capabilities
		? {
			tier: asString(sources.capabilities.tier),
			proFeatures: typeof sources.capabilities.proFeatures === 'boolean' ? sources.capabilities.proFeatures : null,
			commandReview:
				typeof sources.capabilities?.capabilities?.commandReview === 'number'
					? sources.capabilities.capabilities.commandReview === 1
					: null,
		}
		: null;

	const report: DoctorReport = {
		generatedAt: now,
		versions: {
			cli: sources.cliVersion,
			extension: asString(health?.extensionVersion),
			bridgeApi: asNumber(health?.apiVersion),
			node: sources.nodeVersion,
			platform: sources.platform,
		},
		bridge: {
			reachable: !!health,
			hostKind: asString(health?.hostKind),
			pid: asNumber(health?.pid),
			workspaceRoot: asString(health?.workspaceRoot),
			startedAt: asNumber(health?.startedAt),
			commandCount: Array.isArray(health?.commands) ? health.commands.length : null,
		},
		ownership: {
			leasePresent: !!sources.lease,
			leasePid: asNumber(sources.lease?.pid),
			leaseEditorKind: asString(sources.lease?.editorKind),
			leaseWorkspaceRoot: asString(sources.lease?.workspaceRoot),
			leaseHeartbeatAt: asNumber(sources.lease?.lastHeartbeatAt),
		},
		descriptors,
		listeners,
		instances,
		auth,
		capabilities,
		findings: [],
		recentErrors: (sources.recentErrors || []).map((e) => scrubFreeText(e, 300)),
	};

	report.findings = deriveFindings(report);
	return report;
}

/**
 * Turn the collected facts into the sentences a reader actually needs. A dump
 * that leaves the diagnosis to the reader is not a diagnostic.
 */
export function deriveFindings(report: DoctorReport): string[] {
	const findings: string[] = [];

	if (!report.bridge.reachable) {
		findings.push('No bridge answered a health check on the known ports.');
		if (report.listeners.length) {
			findings.push(
				`Something is listening on the bridge ports but not serving: ${report.listeners
					.map((l) => `PID ${l.pid} on ${l.port} (${l.kind})`)
					.join(', ')}. This is the "alive but not answering" case — it can be taken over.`
			);
		}
	}

	// A descriptor naming a different process than the one actually serving is
	// how a healthy bridge becomes undiscoverable.
	for (const d of report.descriptors) {
		if (d.present && report.bridge.pid && d.pid && d.pid !== report.bridge.pid) {
			findings.push(
				`${d.path} names PID ${d.pid}, but the bridge answering is PID ${report.bridge.pid}. That descriptor is stale.`
			);
		}
	}
	if (report.bridge.reachable && !report.descriptors.some((d) => d.present)) {
		findings.push('The bridge is healthy but has no port descriptor, so it is undiscoverable from other directories.');
	}

	if (report.ownership.leasePresent && report.bridge.pid && report.ownership.leasePid !== report.bridge.pid) {
		findings.push(
			`The owner lease names PID ${report.ownership.leasePid} while PID ${report.bridge.pid} is serving — ownership and reality disagree.`
		);
	}

	// Multiple workspace roots claiming the bridge is the two-window case.
	const roots = new Set(
		[report.bridge.workspaceRoot, report.ownership.leaseWorkspaceRoot, ...report.descriptors.map((d) => d.workspaceRoot)]
			.filter((r): r is string => !!r)
	);
	if (roots.size > 1) {
		findings.push(`More than one workspace claims the bridge: ${Array.from(roots).join(', ')}.`);
	}

	const expired = report.auth.filter((a) => a.state === 'AUTH_EXPIRED');
	if (expired.length) {
		findings.push(
			`ServiceNow rejected the session for ${expired.map((a) => a.instance).join(', ')}. Run /token in the browser for those instances.`
		);
	}
	const unchecked = report.auth.filter((a) => a.state === 'HELPER_DISCONNECTED');
	if (unchecked.length) {
		findings.push('The SN Utils helper tab is not connected, so no session could be verified.');
	}

	// A probe that did not return a verdict is not a passing probe. Saying
	// nothing about it and then declaring "session checks passed" is the same
	// over-claim this diagnostic exists to catch.
	const unknown = report.auth.filter((a) => a.state === 'AUTH_UNKNOWN' || a.state === 'AUTH_UNSUPPORTED');
	if (unknown.length) {
		findings.push(
			`The session could not be verified for ${unknown.map((a) => a.instance).join(', ')} — the probe returned no verdict. Retry before treating those instances as usable.`
		);
	}

	// Never-connected instances are normal, not broken. Worth stating so the
	// difference between "no session yet" and "session rejected" is visible.
	const missing = report.auth.filter((a) => a.state === 'AUTH_MISSING');
	if (missing.length) {
		findings.push(
			`No session yet for ${missing.map((a) => a.instance).join(', ')}. That is expected until the instance is opened in the browser and /token is run.`
		);
	}

	if (!findings.length) {
		const verified = report.auth.filter((a) => a.ok).length;
		findings.push(
			report.auth.length
				? `No problems found: a bridge is serving, its registration matches, and all ${verified} instance session${verified === 1 ? '' : 's'} verified.`
				: 'No problems found: a bridge is serving and its registration matches. No instance sessions were checked.'
		);
	}
	return findings;
}

/** Human-readable summary. The JSON form carries everything; this carries the point. */
export function formatDoctorReport(report: DoctorReport): string {
	const lines: string[] = [];
	const yn = (v: boolean) => (v ? 'yes' : 'no');

	lines.push('');
	lines.push('SN Utils bridge diagnostic');
	lines.push('');
	lines.push(`  CLI            ${report.versions.cli}`);
	lines.push(`  Extension      ${report.versions.extension ?? 'not reported'}`);
	lines.push(`  Bridge API     ${report.versions.bridgeApi ?? 'unknown'}`);
	lines.push(`  Node/platform  ${report.versions.node} on ${report.versions.platform}`);
	lines.push('');
	lines.push(`  Bridge         ${report.bridge.reachable ? 'answering' : 'not answering'}`);
	if (report.bridge.reachable) {
		lines.push(`    host         ${report.bridge.hostKind ?? 'unknown'} (PID ${report.bridge.pid ?? '?'})`);
		lines.push(`    workspace    ${report.bridge.workspaceRoot ?? 'not reported'}`);
		lines.push(`    commands     ${report.bridge.commandCount ?? '?'}`);
	}
	lines.push(`  Owner lease    ${yn(report.ownership.leasePresent)}${report.ownership.leasePid ? ` (PID ${report.ownership.leasePid}, ${report.ownership.leaseEditorKind ?? 'unknown editor'})` : ''}`);

	if (report.descriptors.length) {
		lines.push('');
		lines.push('  Port descriptors');
		for (const d of report.descriptors) {
			lines.push(`    ${d.present ? '✓' : '✗'} ${d.path}${d.present ? ` — PID ${d.pid ?? '?'}, port ${d.port ?? '?'}` : ''}`);
		}
	}

	if (report.listeners.length) {
		lines.push('');
		lines.push('  Listening on bridge ports');
		for (const l of report.listeners) {
			lines.push(`    ${l.port}  PID ${l.pid}  [${l.kind}]  ${l.command}`);
		}
	}

	if (report.auth.length) {
		lines.push('');
		lines.push('  Instance sessions');
		for (const a of report.auth) {
			lines.push(`    ${a.ok ? '✓' : '✗'} ${a.instance}  ${a.state}`);
		}
	}

	lines.push('');
	lines.push('  Findings');
	for (const f of report.findings) lines.push(`    • ${f}`);
	lines.push('');
	lines.push('  No tokens, session material or settings files are included in this report.');
	lines.push('');
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Collection. Everything below reads the machine; nothing below decides what
// is safe to print — that is buildDoctorReport's job, and keeping the two
// apart is what makes the redaction testable.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkHealth, ScriptSyncClient, findWorkspacePortFile, getGlobalPortFilePath } from '../client.js';
import { findPortListener, classifyListener } from './portReclaim.js';

function readJsonIfPresent(file: string): { path: string; data: any | null; error?: string } {
  try {
    if (!fs.existsSync(file)) return { path: file, data: null };
    return { path: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err: any) {
    return { path: file, data: null, error: `unreadable: ${err?.message || err}` };
  }
}

/** Gather everything a diagnosis needs, tolerating every part being absent. */
export async function collectDoctorSources(options: {
  cliVersion: string;
  cwd: string;
  httpPort?: number;
  wsPort?: number;
}): Promise<DoctorSources> {
  const httpPort = options.httpPort ?? 1977;
  const wsPort = options.wsPort ?? 1978;

  const descriptorPaths = [findWorkspacePortFile(options.cwd), getGlobalPortFilePath()]
    .filter((p): p is string => !!p);
  const descriptors = descriptorPaths.map(readJsonIfPresent);

  const leaseFile = path.join(os.homedir(), '.sn-scriptsync', 'bridge-owner.json');
  const lease = readJsonIfPresent(leaseFile).data;

  let health: any;
  try {
    health = await checkHealth(httpPort);
  } catch {
    // A descriptor may point at an ephemeral port instead of the fixed one.
    for (const d of descriptors) {
      const port = d.data?.port;
      if (typeof port === 'number' && port !== httpPort) {
        try { health = await checkHealth(port); break; } catch { /* keep looking */ }
      }
    }
  }

  const listeners = await Promise.all(
    [httpPort, wsPort].map(async (port) => {
      const listener = await findPortListener(port);
      return listener
        ? { port, pid: listener.pid, command: listener.command, kind: classifyListener(listener.command) }
        : null;
    })
  );

  // Instances and per-instance session state need a working bridge; without
  // one these stay empty rather than failing the whole diagnostic.
  let instances: DoctorSources['instances'] = [];
  let auth: DoctorSources['auth'] = [];
  let capabilities: any;
  if (health) {
    const client = new ScriptSyncClient({ cwd: options.cwd });
    try {
      const listed = await client.execute({ command: 'list_instances', params: {} }, 5_000);
      instances = (listed.result?.instances || []).map((i: any) => ({
        name: i.name,
        url: i.url ?? null,
        hasSettings: i.hasSettings !== false,
      }));
    } catch { /* no instances is itself a finding */ }

    for (const instance of instances) {
      try {
        const probe = await client.execute({ command: 'auth_status', instance: instance.name, params: {} }, 15_000);
        auth.push({
          instance: instance.name,
          state: probe.result?.state,
          ok: probe.result?.ok,
          lastValidatedAt: probe.result?.lastValidatedAt,
        });
      } catch (err: any) {
        auth.push({ instance: instance.name, state: err?.code === 'E_UNKNOWN_COMMAND' ? 'AUTH_UNSUPPORTED' : 'AUTH_UNKNOWN', ok: false });
      }
    }

    try {
      const caps = await client.execute({ command: 'get_capabilities', params: {} }, 5_000);
      capabilities = caps.result;
    } catch { /* helper tab may be closed */ }
  }

  return {
    cliVersion: options.cliVersion,
    descriptors,
    health,
    listeners,
    lease,
    instances,
    auth,
    capabilities,
    recentErrors: [],
    platform: `${os.platform()} ${os.release()}`,
    nodeVersion: process.version,
    cwd: options.cwd,
  };
}
