import { checkHealth, discoverBridge, ScriptSyncClientError } from '../client.js';
import { DiscoveryOptions, DiscoveryResult, HealthResponse } from '../types.js';

interface YieldResponse {
  ok: boolean;
  status: number;
  json(): Promise<{ status?: string; error?: string }>;
}

type YieldFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<YieldResponse>;

export interface ActiveBridgeStatus {
  running: true;
  discovery: DiscoveryResult;
  health: HealthResponse;
}

export interface InactiveBridgeStatus {
  running: false;
}

export type BridgeStatus = ActiveBridgeStatus | InactiveBridgeStatus;

export async function inspectBridge(options: DiscoveryOptions = {}): Promise<BridgeStatus> {
  try {
    const discovery = await discoverBridge(options);
    const health = await checkHealth(discovery.port, discovery.pid);
    return { running: true, discovery, health };
  } catch (err: any) {
    if (
      err?.code === 'E_BRIDGE_NOT_FOUND' ||
      err?.code === 'E_BRIDGE_UNREACHABLE' ||
      err?.code === 'E_STALE_PORT_FILE'
    ) {
      return { running: false };
    }
    throw err;
  }
}

export function assertStandaloneBridge(status: BridgeStatus): asserts status is ActiveBridgeStatus {
  if (!status.running) {
    throw new ScriptSyncClientError('No active SN Utils standalone bridge found.', 'E_SERVER_NOT_RUNNING');
  }
  if (status.health.hostKind !== 'standalone') {
    throw new ScriptSyncClientError(
      'The active bridge is owned by VS Code. Stop or restart it from VS Code instead.',
      'E_NOT_STANDALONE'
    );
  }
  if (status.health.pid !== status.discovery.pid) {
    throw new ScriptSyncClientError('Bridge PID changed during lifecycle check.', 'E_STALE_PORT_FILE');
  }
}

export async function requestStandaloneYield(
  status: BridgeStatus,
  fetchImpl: YieldFetch = fetch as unknown as YieldFetch
): Promise<void> {
  assertStandaloneBridge(status);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${status.discovery.port}/api/yield`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': status.discovery.token,
      },
      body: JSON.stringify({ id: `snu_lifecycle_${Date.now()}`, command: 'yield', params: {} }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as { status?: string; error?: string };
    if (!response.ok || payload.status !== 'success') {
      throw new ScriptSyncClientError(
        payload.error || `Standalone bridge refused to stop (HTTP ${response.status}).`,
        'E_STOP_FAILED',
        response.status
      );
    }
  } catch (err: any) {
    if (err instanceof ScriptSyncClientError) throw err;
    throw new ScriptSyncClientError(
      `Could not stop standalone bridge: ${err?.message || err}`,
      'E_STOP_FAILED'
    );
  } finally {
    clearTimeout(timer);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForBridgeExit(
  pid: number,
  timeoutMs = 5_000,
  aliveCheck: (pid: number) => boolean = isPidAlive
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!aliveCheck(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new ScriptSyncClientError(
    `Standalone bridge PID ${pid} did not stop within ${timeoutMs / 1000}s.`,
    'E_STOP_TIMEOUT'
  );
}
