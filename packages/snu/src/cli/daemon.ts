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

/**
 * Send a lifecycle command to an editor-hosted bridge.
 *
 * The standalone bridge exposes /api/yield; the editor host routes everything
 * through POST /api. Recovering an editor-hosted bridge used to be impossible
 * from here — the CLI refused, and the user had to find and kill an extension
 * host PID by hand. Asking the owning window to stand down is the safe
 * equivalent: no signals are ever sent to an editor process.
 */
export async function requestEditorBridgeLifecycle(
  status: ActiveBridgeStatus,
  command: 'yield' | 'restart',
  fetchImpl: YieldFetch = fetch as unknown as YieldFetch
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${status.discovery.port}/api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': status.discovery.token,
      },
      body: JSON.stringify({ id: `snu_lifecycle_${command}`, command, params: {} }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as { status?: string; error?: string };
    if (!response.ok || payload.status !== 'success') {
      throw new ScriptSyncClientError(
        payload.error || `The editor-hosted bridge refused to ${command} (HTTP ${response.status}).`,
        command === 'yield' ? 'E_STOP_FAILED' : 'E_RESTART_FAILED',
        response.status
      );
    }
  } catch (err: any) {
    if (err instanceof ScriptSyncClientError) throw err;
    throw new ScriptSyncClientError(
      `Could not ${command} the editor-hosted bridge: ${err?.message || err}`,
      command === 'yield' ? 'E_STOP_FAILED' : 'E_RESTART_FAILED'
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for an editor-hosted bridge to go quiet.
 *
 * The extension-host process itself stays alive, so PID liveness proves
 * nothing here — the health endpoint is the only honest signal.
 */
export async function waitForBridgeUnreachable(port: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await checkHealth(port);
    } catch {
      return; // no longer answering: the transports are down
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new ScriptSyncClientError(
    `The bridge on port ${port} was still answering after ${timeoutMs / 1000}s.`,
    'E_STOP_TIMEOUT'
  );
}

/** Wait for a bridge to answer again after a restart. */
export async function waitForBridgeReachable(port: number, timeoutMs = 20_000): Promise<HealthResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await checkHealth(port);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new ScriptSyncClientError(
    `The bridge did not come back on port ${port} within ${timeoutMs / 1000}s: ${
      (lastError as any)?.message || lastError
    }`,
    'E_RESTART_FAILED'
  );
}
