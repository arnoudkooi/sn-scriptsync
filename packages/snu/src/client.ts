import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  AgentRequest,
  AgentResponse,
  AgentPortFile,
  DiscoveryOptions,
  DiscoveryResult,
  HealthResponse,
  MappedCommand,
  AGENT_API_VERSION,
} from './types.js';
import { getCommandPolicy } from './server/policy.js';

export const MIN_API_VERSION = 7;
export const DEFAULT_COMMAND_TIMEOUT_MS = 70_000;
export const REVIEWED_COMMAND_TIMEOUT_MS = 310_000; // 5m 10s
export const HEALTH_CHECK_TIMEOUT_MS = 1_500;

const CONTEXT_GATE_KEYS = [
  'backgroundScripts',
  'deleteRecords',
  'createArtifacts',
  'browserDebugger',
  'restRequest',
] as const;

type ContextGateKey = (typeof CONTEXT_GATE_KEYS)[number];
type ContextInstanceGate = 'off' | 'approve' | 'auto' | 'on' | 'missing' | null;
type ContextGateResult = 'blocked_host' | 'blocked_instance' | 'approval_required' | 'allowed' | 'unknown';

export interface ContextSecurity {
  instance: { name: string; url: string | null; origin: string | null } | null;
  availableInstancePolicies: Array<{ name: string; origin: string }>;
  hostGates: Record<string, boolean> | null;
  instanceGates: Record<string, any> | null;
  instanceGateProtocol: boolean;
  effectiveGates: Record<ContextGateKey, {
    host: boolean | null;
    instance: ContextInstanceGate;
    result: ContextGateResult;
  }>;
}

function canonicalOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolve the host and helper-tab policies for the selected instance. Exported
 * so the deny-wins calculation can be tested independently of a live bridge.
 */
export function resolveContextSecurity(
  capabilities: any,
  instancesData: any,
  requestedInstance?: string,
  resolvedInstanceInfo?: any
): ContextSecurity {
  const instances = Array.isArray(instancesData?.instances) ? instancesData.instances : [];
  const resolvedName = resolvedInstanceInfo?.instanceName || requestedInstance || instancesData?.defaultInstance || null;
  const requestedOrigin = canonicalOrigin(requestedInstance);
  let target = instances.find((candidate: any) => {
    if (resolvedName && String(candidate?.name).toLowerCase() === String(resolvedName).toLowerCase()) return true;
    return requestedOrigin !== null && canonicalOrigin(candidate?.url) === requestedOrigin;
  }) || null;

  const hostGates = capabilities?.gates && typeof capabilities.gates === 'object'
    ? capabilities.gates as Record<string, boolean>
    : null;
  const instanceGateProtocol = capabilities?.capabilities?.instanceSecurityGates === 1;
  const snapshots = capabilities?.instanceGates && typeof capabilities.instanceGates === 'object'
    ? capabilities.instanceGates
    : {};
  const availableInstancePolicies = Object.keys(snapshots).flatMap((value) => {
    const origin = canonicalOrigin(value);
    if (!origin) return [];
    const name = new URL(origin).hostname.split('.')[0];
    return [{ name, origin }];
  });
  if (!target) {
    const requested = String(resolvedName || '').toLowerCase();
    const matchingPolicy = availableInstancePolicies.find((candidate) =>
      candidate.origin === requestedOrigin || candidate.name.toLowerCase() === requested
    ) || (!resolvedName && availableInstancePolicies.length === 1 ? availableInstancePolicies[0] : null);
    if (matchingPolicy) {
      target = { name: matchingPolicy.name, url: matchingPolicy.origin };
    }
  }
  const targetOrigin = canonicalOrigin(target?.url);
  const snapshot = targetOrigin ? snapshots[targetOrigin] : null;
  const selectedInstanceGates = snapshot?.gates && typeof snapshot.gates === 'object' ? snapshot.gates : null;
  const reviewCapable = capabilities?.capabilities?.commandReview === 1;

  const effectiveGates = {} as ContextSecurity['effectiveGates'];
  for (const key of CONTEXT_GATE_KEYS) {
    const host = hostGates ? hostGates[key] === true : null;
    const rawInstance = selectedInstanceGates?.[key];
    let instance: ContextInstanceGate = null;
    if (instanceGateProtocol) {
      if (!selectedInstanceGates || rawInstance === undefined) instance = 'missing';
      else if (rawInstance === true) instance = 'on';
      else if (rawInstance === false) instance = 'off';
      else if (rawInstance === 'off' || rawInstance === 'approve' || rawInstance === 'auto') instance = rawInstance;
      else instance = 'missing';
    }

    let result: ContextGateResult;
    if (host === false) {
      result = 'blocked_host';
    } else if (instanceGateProtocol && (instance === 'off' || instance === 'missing')) {
      result = 'blocked_instance';
    } else if (
      instanceGateProtocol &&
      instance === 'approve' &&
      reviewCapable &&
      (key === 'backgroundScripts' || key === 'deleteRecords')
    ) {
      result = 'approval_required';
    } else if (host === true || (instanceGateProtocol && (instance === 'auto' || instance === 'approve' || instance === 'on'))) {
      result = 'allowed';
    } else {
      result = 'unknown';
    }

    effectiveGates[key] = { host, instance, result };
  }

  return {
    instance: target ? { name: String(target.name), url: target.url || null, origin: targetOrigin } : null,
    availableInstancePolicies,
    hostGates,
    instanceGates: selectedInstanceGates,
    instanceGateProtocol,
    effectiveGates,
  };
}

export class ScriptSyncClientError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'ScriptSyncClientError';
  }
}

/**
 * Global port file path (~/.sn-scriptsync/agent-port.json).
 * Written when a Pro/Trial/Enterprise license is connected in the browser.
 */
export function getGlobalPortFilePath(): string {
  return path.join(os.homedir(), '.sn-scriptsync', 'agent-port.json');
}

/**
 * Walk up directory tree from startDir looking for .vscode/sn-agent-port.json.
 */
export function findWorkspacePortFile(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.vscode', 'sn-agent-port.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break; // Reached filesystem root
    }
    current = parent;
  }
  return undefined;
}

/**
 * Discover the active ScriptSync bridge port and token using deterministic precedence.
 */
export async function discoverBridge(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const cwd = options.cwd || process.cwd();

  // 1. Explicit port-file option if provided
  if (options.portFile) {
    if (!fs.existsSync(options.portFile)) {
      throw new ScriptSyncClientError(
        `Specified port file does not exist: ${options.portFile}`,
        'E_PORT_FILE_NOT_FOUND'
      );
    }
    return await validatePortFile(options.portFile, false);
  }

  // 2. Upward traversal in current workspace for .vscode/sn-agent-port.json
  const wsPortFile = findWorkspacePortFile(cwd);
  if (wsPortFile) {
    try {
      return await validatePortFile(wsPortFile, false);
    } catch (err: any) {
      // Stale or dead workspace port file
      if (err.code === 'E_STALE_PORT_FILE' || err.code === 'E_BRIDGE_UNREACHABLE') {
        // Fall through to global port file check
      } else {
        throw err;
      }
    }
  }

  // 3. Fallback to global user port file (~/.sn-scriptsync/agent-port.json)
  const globalPortFile = getGlobalPortFilePath();
  if (fs.existsSync(globalPortFile)) {
    try {
      return await validatePortFile(globalPortFile, true);
    } catch (err: any) {
      if (err.code === 'E_STALE_PORT_FILE' || err.code === 'E_BRIDGE_UNREACHABLE') {
        // Drop through to final error
      } else {
        throw err;
      }
    }
  }

  throw new ScriptSyncClientError(
    'No active ScriptSync bridge found. Open your ServiceNow project folder in VS Code with sn-scriptsync active, or start standalone with `snu serve`.',
    'E_BRIDGE_NOT_FOUND'
  );
}

/**
 * Validate a candidate port file: parse JSON, check PID liveness, and verify /api/health.
 */
async function validatePortFile(filePath: string, isGlobal: boolean): Promise<DiscoveryResult> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    throw new ScriptSyncClientError(`Failed to read port file at ${filePath}: ${err?.message || err}`, 'E_PORT_FILE_READ_ERROR');
  }

  let data: AgentPortFile;
  try {
    data = JSON.parse(raw);
  } catch (err: any) {
    throw new ScriptSyncClientError(`Corrupt port file JSON at ${filePath}`, 'E_PORT_FILE_CORRUPT');
  }

  if (!data.port || !data.token || typeof data.pid !== 'number') {
    throw new ScriptSyncClientError(`Invalid port file structure at ${filePath}`, 'E_PORT_FILE_INVALID');
  }

  // Validate process liveness via PID (kill -0)
  if (typeof process.kill === 'function') {
    try {
      process.kill(data.pid, 0);
    } catch {
      throw new ScriptSyncClientError(
        `Bridge process with PID ${data.pid} is no longer running (stale port file at ${filePath})`,
        'E_STALE_PORT_FILE'
      );
    }
  }

  // Probe /api/health to ensure the bridge is healthy and API version is compatible
  await checkHealth(data.port, data.pid);

  return {
    port: data.port,
    token: data.token,
    pid: data.pid,
    apiVersion: data.apiVersion || AGENT_API_VERSION,
    portFilePath: filePath,
    isGlobal,
  };
}

/**
 * Probe GET /api/health with a short timeout.
 */
export async function checkHealth(port: number, expectedPid?: number): Promise<HealthResponse> {
  const url = `http://127.0.0.1:${port}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Health check returned HTTP ${res.status}`);
    }
    const health = (await res.json()) as HealthResponse;
    if (health.status !== 'success') {
      throw new Error('Health check response missing status=success');
    }
    if (typeof health.apiVersion === 'number' && health.apiVersion < MIN_API_VERSION) {
      throw new ScriptSyncClientError(
        `ScriptSync server API version ${health.apiVersion} is older than minimum supported ${MIN_API_VERSION}`,
        'E_API_VERSION_INCOMPATIBLE'
      );
    }
    if (expectedPid !== undefined && health.pid !== expectedPid) {
      throw new ScriptSyncClientError(
        `PID mismatch: port file declared PID ${expectedPid}, but server on port ${port} is running as PID ${health.pid}`,
        'E_STALE_PORT_FILE'
      );
    }
    return health;
  } catch (err: any) {
    if (err instanceof ScriptSyncClientError) throw err;
    throw new ScriptSyncClientError(
      `Cannot reach ScriptSync bridge on 127.0.0.1:${port}: ${err?.message || err}`,
      'E_BRIDGE_UNREACHABLE'
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ScriptSync Client for sending typed commands to the bridge.
 */
export class ScriptSyncClient {
  private discoveryResult?: DiscoveryResult;

  constructor(private options?: DiscoveryOptions) {}

  async getDiscovery(): Promise<DiscoveryResult> {
    if (!this.discoveryResult) {
      this.discoveryResult = await discoverBridge(this.options);
    }
    return this.discoveryResult;
  }

  async execute<T = any>(
    mapped: MappedCommand,
    timeoutMs?: number
  ): Promise<AgentResponse<T>> {
    const discovery = await this.getDiscovery();
    const url = `http://127.0.0.1:${discovery.port}/api`;
    const requestId = `snu_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const payload: AgentRequest = {
      id: requestId,
      command: mapped.command,
      params: mapped.params,
    };
    if (mapped.instance) {
      payload.instance = mapped.instance;
    }

    const policy = getCommandPolicy(payload);
    const isReviewedCommand = policy.review === 'required';
    const effectiveTimeout = timeoutMs !== undefined
      ? timeoutMs
      : isReviewedCommand
      ? REVIEWED_COMMAND_TIMEOUT_MS
      : DEFAULT_COMMAND_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Token': discovery.token,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let json: AgentResponse<T>;
      try {
        json = (await res.json()) as AgentResponse<T>;
      } catch (parseErr: any) {
        throw new ScriptSyncClientError(
          `Failed to parse server response: ${parseErr?.message || parseErr}`,
          'E_INVALID_RESPONSE',
          res.status
        );
      }

      if (json.status === 'error' || !res.ok) {
        // Auto-fallback: If multiple instances exist and none was specified, check if there is a unique recently-active defaultInstance
        if (json.code === 'E_INSTANCE_REQUIRED' && !mapped.instance && mapped.command !== 'list_instances') {
          try {
            const listResp = await this.execute({ command: 'list_instances', params: {} }, 3000);
            const defaultInst = listResp.result?.defaultInstance;
            if (defaultInst) {
              return await this.execute<T>({ ...mapped, instance: defaultInst }, effectiveTimeout);
            }
          } catch {
            // Ignore failure to fetch default instance and throw original error
          }
        }

        // A bridge that predates a command answers E_UNKNOWN_COMMAND, which on
        // its own reads like a bug in the caller. Name the actual cause so the
        // agent reports "update the extension" instead of hunting for another
        // way to do the same write.
        let message = json.error || `Command ${mapped.command} failed`;
        if ((json.code || '') === 'E_UNKNOWN_COMMAND') {
          message += ` The connected ScriptSync bridge does not implement '${mapped.command}'. If VS Code is hosting the bridge, update the sn-scriptsync extension; otherwise update @snutils/snu.`;
        }

        throw new ScriptSyncClientError(
          message,
          json.code || 'E_COMMAND_FAILED',
          res.status,
          json.details || json.result
        );
      }

      return json;
    } catch (err: any) {
      if (err instanceof ScriptSyncClientError) throw err;
      if (err.name === 'AbortError') {
        throw new ScriptSyncClientError(
          `Command '${mapped.command}' timed out after ${effectiveTimeout / 1000}s`,
          'E_TIMEOUT'
        );
      }
      throw new ScriptSyncClientError(
        `Failed to communicate with ScriptSync Agent API: ${err?.message || err}`,
        'E_NETWORK_ERROR'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Composite context fetcher for `snu context` / `snu_get_context`
   */
  async getContext(instance?: string): Promise<Record<string, any>> {
    // 1. Connection check
    const connResp = await this.execute({ command: 'check_connection', params: {} });
    const conn = connResp.result || {};

    // 2. List instances roster
    const instancesResp = await this.execute({ command: 'list_instances', params: {} });
    const instancesData = instancesResp.result || {};

    let specificInstanceInfo: any = null;
    if (instance) {
      try {
        const instResp = await this.execute({ command: 'get_instance_info', instance, params: {} });
        specificInstanceInfo = instResp.result;
      } catch {}
    }

    // 3. Try get_capabilities
    let capabilities: any = null;
    let browserConnected = conn.browserConnected === true;

    if (browserConnected) {
      try {
        const capResp = await this.execute({ command: 'get_capabilities', params: {} });
        capabilities = capResp.result;
      } catch (e: any) {
        if (e.code === 'E_BROWSER_DISCONNECTED') {
          browserConnected = false;
        }
      }
    }

    const bridgeReady = conn.serverRunning === true;
    const security = resolveContextSecurity(capabilities, instancesData, instance, specificInstanceInfo);

    // The one question local state cannot answer: does ServiceNow still accept
    // the session? Everything above is inferred from the bridge's own view, and
    // during the 2026-08-29 incident all of it was true while every operation
    // returned 401. Ask, rather than assume.
    let auth: Record<string, any> | null = null;
    if (bridgeReady && browserConnected) {
      try {
        const authResp = await this.execute({ command: 'auth_status', instance, params: {} }, 15_000);
        auth = authResp.result || null;
      } catch (err: any) {
        // An older bridge has no auth_status. Say so rather than silently
        // falling back to the optimistic answer this replaces.
        auth = {
          state: err?.code === 'E_UNKNOWN_COMMAND' ? 'AUTH_UNSUPPORTED' : 'AUTH_UNKNOWN',
          ok: false,
          message:
            err?.code === 'E_UNKNOWN_COMMAND'
              ? 'This bridge predates the session check; readiness cannot be confirmed. Update the sn-scriptsync extension or @snutils/snu.'
              : `The session check did not complete: ${err?.message || err}`,
        };
      }
    }

    // Seven independent facts, not one overloaded word. Each is separately
    // false-able, so a report can name exactly which link is broken.
    const health = {
      httpReachable: bridgeReady,
      wsListening: bridgeReady,
      helperConnected: browserConnected,
      instanceKnown: auth ? auth.state !== 'INSTANCE_NOT_FOUND' : !!instancesData.instances?.length,
      sessionPresent: auth ? auth.state !== 'AUTH_MISSING' : null,
      authProbe: auth ? { ok: auth.ok === true, state: auth.state, detail: auth.detail ?? null } : null,
      lastAuthenticatedAt: auth?.lastUsedAt ?? auth?.lastValidatedAt ?? null,
    };

    // Ready means every link is proven, including the last one.
    const serviceNowReady = bridgeReady && browserConnected && auth?.ok === true;

    return {
      bridgeReady,
      serviceNowReady,
      browserConnected,
      health,
      auth,
      message: serviceNowReady
        ? 'Connected and ready'
        : !bridgeReady
        ? 'WebSocket server not running.'
        : !browserConnected
        ? 'Bridge active. Helper tab disconnected (open via /token in ServiceNow tab).'
        : auth?.message || 'Bridge and helper connected; the ServiceNow session could not be confirmed.',
      helper: capabilities
        ? {
            tier: capabilities.tier,
            proFeatures: capabilities.proFeatures,
            cdp: capabilities.cdp,
            capabilities: capabilities.capabilities,
          }
        : conn.helper || null,
      gates: capabilities?.gates || null,
      instanceGates: capabilities?.instanceGates || null,
      security,
      instances: instancesData.instances || [],
      defaultInstance: instancesData.defaultInstance || null,
      selectedInstance: specificInstanceInfo,
    };
  }
}
