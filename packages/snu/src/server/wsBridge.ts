import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { defaultPendingRegistry, PendingRegistry } from './pendingRegistry.js';
import { HelperCapabilities, InstanceGateSnapshot, SecurityGates, ReviewEnvelope } from '../types.js';

export interface HelperState {
  tier: 'free' | 'pro' | 'trial' | 'enterprise';
  proFeatures: boolean;
  cdp: { available: boolean; reason: string | null };
  capabilities: HelperCapabilities;
  sessionEpoch: string;
  instanceGates: Map<string, InstanceGateSnapshot>;
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
  private activeClient?: WebSocket;
  private state: HelperState = {
    tier: 'free',
    proFeatures: false,
    cdp: { available: false, reason: 'E_PRO_REQUIRED' },
    capabilities: { protocolVersion: 1 },
    sessionEpoch: '',
    instanceGates: new Map(),
  };
  private activeReviews = new Map<string, ActiveReview>();

  constructor(
    private port = 1978,
    private pending: PendingRegistry = defaultPendingRegistry
  ) {}

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

        wss.on('connection', (ws) => {
          if (this.activeClient && this.activeClient !== ws) {
            try {
              this.activeClient.close(1000, 'Replaced by new connection');
            } catch {}
          }
          this.activeClient = ws;
          this.state.sessionEpoch = crypto.randomUUID();

          // Send host hello
          try {
            ws.send(
              JSON.stringify({
                action: 'hostHello',
                protocolVersion: 1,
                hostKind: 'standalone',
                sessionEpoch: this.state.sessionEpoch,
                features: {
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

          ws.on('close', () => {
            if (this.activeClient === ws) {
              this.activeClient = undefined;
              this.resetHelperState();
              this.pending.rejectAll('E_BROWSER_DISCONNECTED', 'Browser helper disconnected');
            }
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private resetHelperState(): void {
    this.state = {
      tier: 'free',
      proFeatures: false,
      cdp: { available: false, reason: 'E_PRO_REQUIRED' },
      capabilities: { protocolVersion: 1 },
      sessionEpoch: '',
      instanceGates: new Map(),
    };
    this.activeReviews.clear();
  }

  private handleMessage(ws: WebSocket, msg: any): void {
    if (ws !== this.activeClient) return;

    // 1. Immutable merge for license / build info
    if (msg.action === 'helperLicenseInfo' || msg.action === 'helperBuildInfo' || msg.action === 'helperHello') {
      if (msg.tier) this.state.tier = msg.tier;
      if (typeof msg.proFeatures === 'boolean') this.state.proFeatures = msg.proFeatures;
      if (msg.cdp) this.state.cdp = msg.cdp;
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
      if (msg.success === false && msg.code) {
        this.pending.reject(msg.agentRequestId, msg.code, msg.error || 'Command failed', msg.details);
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
      throw new Error('No browser helper connected. Open the SN Utils helper tab via /token.');
    }
    this.activeClient.send(JSON.stringify(payload));
  }

  hasBrowserClient(): boolean {
    return !!this.activeClient && this.activeClient.readyState === WebSocket.OPEN;
  }

  getHelperState(): HelperState {
    return this.state;
  }

  getInstanceGate(instanceUrl?: string, gate?: keyof SecurityGates): import('./policy.js').GateMode {
    if (!instanceUrl || !gate) return 'off';
    try {
      const origin = new URL(instanceUrl).origin.toLowerCase();
      const snap = this.state.instanceGates.get(origin);
      if (snap) {
        return snap.gates[gate] ?? 'approve';
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
    if (this.activeClient) {
      try {
        this.activeClient.close();
      } catch {}
      this.activeClient = undefined;
    }
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
