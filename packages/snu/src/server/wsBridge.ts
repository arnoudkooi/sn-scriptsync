import { loadBridgeId } from './bridgeIdentity.js';
import * as crypto from 'crypto';
import { HelperConnection } from './helperConnection.js';
import { WebSocketServer, WebSocket } from 'ws';
import { defaultPendingRegistry, PendingRegistry } from './pendingRegistry.js';
import { resolveGateMode } from './policy.js';
import { HelperCapabilities, InstanceGateSnapshot, SecurityGates, ReviewEnvelope } from '../types.js';

export interface HelperState {
  tier: 'free' | 'pro' | 'trial' | 'enterprise';
  proFeatures: boolean;
  cdp: { available: boolean; reason: string | null };
  capabilities: HelperCapabilities;
  sessionEpoch: string;
  instanceGates: Map<string, InstanceGateSnapshot>;
  liveInstances: Map<string, LiveInstance>;
}

export interface LiveInstance {
  name: string;
  url: string;
  g_ck: string;
  lastActiveAt: number;
}

export interface ActiveReview {
  reviewId: string;
  nonce: string;
  payloadHash: string;
  consumed: boolean;
  correlationId: string;
  command: string;
  params: any;
  instanceOrigin: string;
  createdAt: number;
}

export class StandaloneWsBridge {
  private wss?: WebSocketServer;
  private helperConnection: HelperConnection<WebSocket>;
  private get activeClient(): WebSocket | undefined { return this.helperConnection.current; }
  // Whether the connected helper's build carries the debugger permission
  // (helperBuildInfo.debuggerAvailable). Combined with proFeatures from
  // helperLicenseInfo to derive cdp, since the helper never sends a cdp field
  // in its handshake; before this the placeholder reason E_PRO_REQUIRED was
  // reported to every user, whatever their tier or build.
  private debuggerAvailable?: boolean;
  private state: HelperState = {
    tier: 'free',
    proFeatures: false,
    cdp: { available: false, reason: null },
    capabilities: { protocolVersion: 1 },
    sessionEpoch: '',
    instanceGates: new Map(),
    liveInstances: new Map(),
  };
  private activeReviews = new Map<string, ActiveReview>();

  // Wired by StandaloneBridge to the dispatcher so ServiceNow save-icon
  // pushes land in the sync workspace instead of being dropped.
  onSaveFieldAsFile?: (msg: any) => void;

  private bridgeId = '';

  constructor(
    private port = 1978,
    private pending: PendingRegistry = defaultPendingRegistry,
    heartbeatMs = 30_000,
    bridgeId: string | (() => string) = loadBridgeId,
  ) {
    try { this.bridgeId = typeof bridgeId === 'function' ? bridgeId() : bridgeId; } catch { this.bridgeId = ''; }
    this.helperConnection = new HelperConnection<WebSocket>(() => {
      this.resetHelperState();
      this.pending.rejectAll('E_BROWSER_DISCONNECTED', 'Browser helper disconnected');
    }, heartbeatMs);
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        const wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' }, () => {
          this.wss = wss;
          const addr = wss.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
          this.port = actualPort;
          resolve(actualPort);
        });

        wss.on('error', (err) => {
          reject(err);
        });

        wss.on('connection', (ws, req) => {
          // Browser helpers must be extension pages, including when a web page
          // has an opaque (null) Origin. Native clients may omit Origin.
          const origin = req?.headers?.origin;
          if (origin !== undefined && !/^(chrome-extension|moz-extension|safari-web-extension):\/\/[^/]+$/.test(origin)) {
            try { ws.close(1008, 'Not allowed'); } catch {}
            return;
          }
          // An automatic reconnect never takes over from a live helper tab.
          if (this.helperConnection.refuseResume(ws, req?.url)) return;
          this.helperConnection.accept(ws);
          this.state.sessionEpoch = crypto.randomUUID();

          // Send host hello
          try {
            ws.send(
              JSON.stringify({
                action: 'hostHello',
                protocolVersion: 1,
                hostKind: 'standalone',
                sessionEpoch: this.state.sessionEpoch,
                // Lets the helper tab recognise this bridge after a restart and
                // refresh session tokens without a manual /token.
                bridgeId: this.bridgeId,
                features: {
                  sessionRefresh: 1,
                  commandReview: 1,
                  rejectionFeedback: 1,
                  instanceSecurityGates: 1,
                },
              })
            );
          } catch {}

          ws.on('message', (raw) => {
            try {
              const msg = JSON.parse(raw.toString('utf8'));
              this.handleMessage(ws, msg);
            } catch {
              // Ignore malformed frames
            }
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private deriveCdp(): HelperState['cdp'] {
    if (this.debuggerAvailable === undefined) return { available: false, reason: null };
    if (!this.debuggerAvailable) return { available: false, reason: 'E_CDP_UNAVAILABLE' };
    if (!this.state.proFeatures) return { available: false, reason: 'E_PRO_REQUIRED' };
    return { available: true, reason: null };
  }

  private resetHelperState(): void {
    this.debuggerAvailable = undefined;
    this.state = {
      tier: 'free',
      proFeatures: false,
      cdp: { available: false, reason: null },
      capabilities: { protocolVersion: 1 },
      sessionEpoch: '',
      instanceGates: new Map(),
      liveInstances: new Map(),
    };
    this.activeReviews.clear();
  }

  private handleMessage(ws: WebSocket, msg: any): void {
    if (ws !== this.activeClient) return;

    // `/token` and all normal instance-to-editor pushes already carry the live
    // instance session object. The standalone bridge has no workspace settings
    // file, so retain that object in memory for CLI/MCP commands. It is cleared
    // as soon as the helper disconnects and is never written to disk.
    if (msg?.instance?.url && msg?.instance?.g_ck) {
      try {
        const origin = new URL(msg.instance.url).origin.toLowerCase();
        const hostname = new URL(origin).hostname;
        const name = typeof msg.instance.name === 'string' && msg.instance.name.trim()
          ? msg.instance.name.trim()
          : hostname.split('.')[0];
        this.state.liveInstances.set(origin, {
          name,
          url: origin,
          g_ck: String(msg.instance.g_ck),
          lastActiveAt: Date.now(),
        });
      } catch {}
    }

    // Acknowledge /token push so the helper tab logs the refresh confirmation
    if (msg?.instance && !msg?.action) {
      try {
        ws.send(
          JSON.stringify({
            refreshedtoken: true,
            appName: 'SN Utils CLI',
            response: msg.silentRefresh === true
              ? `Session token refreshed automatically in snu daemon. Instance: ${msg.instance.name || 'instance'}`
              : `Refreshed token in snu daemon via /token slashcommand. Instance: ${msg.instance.name || 'instance'}`,
          })
        );
      } catch {}
      return;
    }

    // ServiceNow save-icon push: write the field to the sync workspace, the
    // same message VS Code handles as saveFieldAsFile.
    if (msg.action === 'saveFieldAsFile') {
      if (this.onSaveFieldAsFile) this.onSaveFieldAsFile(msg);
      return;
    }

    // 1. Immutable merge for license / build info
    if (msg.action === 'helperLicenseInfo' || msg.action === 'helperBuildInfo' || msg.action === 'helperHello') {
      if (msg.tier) this.state.tier = msg.tier;
      if (typeof msg.proFeatures === 'boolean') this.state.proFeatures = msg.proFeatures;
      if (typeof msg.debuggerAvailable === 'boolean') this.debuggerAvailable = msg.debuggerAvailable;
      // An explicit cdp report wins; otherwise derive it from build + license.
      if (msg.cdp && typeof msg.cdp === 'object') this.state.cdp = msg.cdp;
      else this.state.cdp = this.deriveCdp();
      if (msg.capabilities && typeof msg.capabilities === 'object') {
        this.state.capabilities = {
          ...this.state.capabilities,
          ...msg.capabilities,
          protocolVersion: msg.capabilities.protocolVersion || 1,
        };
      }
      return;
    }

    // 2. Per-Instance Gate Snapshot update
    if (msg.action === 'helperGatesUpdated') {
      try {
        if (!msg.instanceOrigin || typeof msg.instanceOrigin !== 'string' || typeof msg.revision !== 'number') return;
        const origin = new URL(msg.instanceOrigin).origin.toLowerCase();
        const revision = Math.floor(msg.revision);
        if (!Number.isSafeInteger(revision) || revision < 1) return;

        const current = this.state.instanceGates.get(origin);
        if (current && revision <= current.revision) {
          // Discard stale out-of-order revision
          return;
        }

        const rawGates = msg.gates;
        if (!rawGates || typeof rawGates !== 'object') return;

        const isValidGateVal = (v: any) => typeof v === 'boolean' || v === 'off' || v === 'approve' || v === 'auto';

        // Require every field to be a valid gate mode
        if (
          !isValidGateVal(rawGates.backgroundScripts) ||
          !isValidGateVal(rawGates.deleteRecords) ||
          !isValidGateVal(rawGates.createArtifacts) ||
          !isValidGateVal(rawGates.browserDebugger) ||
          !isValidGateVal(rawGates.restRequest)
        ) {
          // Reject malformed / partial gate snapshot
          return;
        }

        const gates: SecurityGates = {
          backgroundScripts: rawGates.backgroundScripts,
          deleteRecords: rawGates.deleteRecords,
          createArtifacts: rawGates.createArtifacts,
          browserDebugger: rawGates.browserDebugger,
          restRequest: rawGates.restRequest,
        };
        // Only newer helper builds publish this one, so it is not required
        // above: left absent it resolves through GATE_FALLBACKS.
        if (isValidGateVal(rawGates.updateRecords)) gates.updateRecords = rawGates.updateRecords;

        this.state.instanceGates.set(origin, {
          instanceOrigin: origin,
          revision,
          receivedAt: Date.now(),
          gates,
        });
      } catch {}
      return;
    }

    // 3. Two-phase review response from browser helper tab
    if (msg.action === 'reviewResponse') {
      const { reviewId, nonce, payloadHash, approved, userFeedback } = msg;
      const active = this.activeReviews.get(reviewId);
      if (!active) return;

      if (active.consumed || active.nonce !== nonce) {
        // Replay or invalid nonce
        this.pending.reject(active.correlationId, 'E_REPLAY_DETECTED', 'Replay detected or invalid review nonce', {
          reviewId,
        });
        this.activeReviews.delete(reviewId);
        return;
      }

      if (active.payloadHash !== payloadHash) {
        this.pending.reject(active.correlationId, 'E_COMMAND_FAILED', 'Payload hash mismatch during review', {
          reviewId,
        });
        this.activeReviews.delete(reviewId);
        return;
      }

      // Check if command is still pending (e.g. has not timed out or been cancelled)
      if (!this.pending.has(active.correlationId)) {
        this.activeReviews.delete(reviewId);
        return;
      }

      active.consumed = true;

      if (!approved) {
        const feedback = typeof userFeedback === 'string' ? userFeedback.slice(0, 1000).trim() : undefined;
        this.pending.reject(
          active.correlationId,
          'E_USER_REJECTED',
          feedback ? `Execution rejected by developer: "${feedback}"` : 'Execution rejected by developer in browser helper tab',
          { userFeedback: feedback, reviewId }
        );
        this.activeReviews.delete(reviewId);
        return;
      }

      // Approved! Authorize execution on helper
      try {
        this.sendToBrowser({
          action: 'executeApproved',
          reviewId,
          nonce,
          payloadHash,
          agentRequestId: active.correlationId,
        });
      } catch (err: any) {
        this.pending.reject(active.correlationId, 'E_BROWSER_DISCONNECTED', err?.message || String(err));
      }
      return;
    }

    // 4. Standard correlated agent responses
    if (msg.agentRequestId) {
      const approvedReview = [...this.activeReviews.values()].find(
        (review) => review.correlationId === msg.agentRequestId && review.consumed
      );
      if (msg.success === false && (msg.code || approvedReview)) {
        const remoteError = msg.error;
        const message = typeof remoteError === 'string'
          ? remoteError
          : remoteError?.message || remoteError?.detail || msg.detail || 'Approved command failed during execution';
        const executionCode = msg.code && msg.code !== 'E_USER_REJECTED' ? msg.code : 'E_COMMAND_FAILED';
        this.pending.reject(msg.agentRequestId, executionCode, message, {
          ...(msg.details && typeof msg.details === 'object' ? msg.details : {}),
          // The helper puts tab hints on the message itself (screenshotResponse
          // names the tab that needs the extension-icon click).
          ...(msg.tabId !== undefined ? { tabId: msg.tabId } : {}),
          ...(msg.tabUrl !== undefined ? { tabUrl: msg.tabUrl } : {}),
          ...(msg.cdpFallbackAvailable !== undefined ? { cdpFallbackAvailable: msg.cdpFallbackAvailable } : {}),
          status: msg.status,
          detail: msg.detail ?? remoteError?.detail ?? null,
          response: msg.data ?? null,
        });
      } else {
        this.pending.resolve(msg.agentRequestId, msg);
      }
    }
  }

  registerReview(active: Omit<ActiveReview, 'consumed' | 'createdAt'>): void {
    this.activeReviews.set(active.reviewId, {
      ...active,
      consumed: false,
      createdAt: Date.now(),
    });
  }

  cancelReview(reviewId: string, reason = 'CANCELLED'): void {
    const active = this.activeReviews.get(reviewId);
    if (active) {
      this.activeReviews.delete(reviewId);
      try {
        this.sendToBrowser({
          action: 'cancelReview',
          reviewId,
          reason,
        });
      } catch {}
    }
  }

  sendToBrowser(payload: any): void {
    if (!this.activeClient || this.activeClient.readyState !== WebSocket.OPEN) {
      // Same code as the dispatcher's precheck, so a helper tab that closes
      // mid-command still surfaces as connect guidance, not a raw failure.
      throw Object.assign(new Error('No browser helper connected. Open the SN Utils helper tab via /token.'), {
        code: 'E_BROWSER_DISCONNECTED',
      });
    }
    this.activeClient.send(JSON.stringify(payload));
  }

  hasBrowserClient(): boolean {
    return !!this.activeClient && this.activeClient.readyState === WebSocket.OPEN;
  }

  getHelperState(): HelperState {
    return this.state;
  }

  getLiveInstances(): LiveInstance[] {
    return [...this.state.liveInstances.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  getInstanceGate(instanceUrl?: string, gate?: keyof SecurityGates): import('./policy.js').GateMode {
    if (!instanceUrl || !gate) return 'off';
    try {
      const origin = new URL(instanceUrl).origin.toLowerCase();
      const snap = this.state.instanceGates.get(origin);
      if (snap) {
        return resolveGateMode(snap.gates, gate) ?? 'approve';
      }
    } catch {}
    return 'off';
  }

  isServerRunning(): boolean {
    return !!this.wss;
  }

  async close(): Promise<void> {
    this.resetHelperState();
    this.pending.rejectAll('E_SERVER_STOPPED', 'ScriptSync server stopped');
    this.helperConnection.stop();
    if (this.wss) {
      return new Promise((resolve) => {
        this.wss!.close(() => {
          this.wss = undefined;
          resolve();
        });
      });
    }
  }
}
