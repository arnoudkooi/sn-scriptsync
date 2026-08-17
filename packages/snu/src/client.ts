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
} from './types.js';
import { getCommandPolicy } from './server/policy.js';

export const MIN_API_VERSION = 7;
export const DEFAULT_COMMAND_TIMEOUT_MS = 70_000;
export const REVIEWED_COMMAND_TIMEOUT_MS = 310_000; // 5m 10s
export const HEALTH_CHECK_TIMEOUT_MS = 1_500;

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
    apiVersion: data.apiVersion || 8,
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

        throw new ScriptSyncClientError(
          json.error || `Command ${mapped.command} failed`,
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
    const serviceNowReady = bridgeReady && browserConnected;

    return {
      bridgeReady,
      serviceNowReady,
      browserConnected,
      message: serviceNowReady
        ? 'Connected and ready'
        : bridgeReady
        ? 'Bridge active. Helper tab disconnected (open via /token in ServiceNow tab).'
        : 'WebSocket server not running.',
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
      instances: instancesData.instances || [],
      defaultInstance: instancesData.defaultInstance || null,
      selectedInstance: specificInstanceInfo,
    };
  }
}
