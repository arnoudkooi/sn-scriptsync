import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { AGENT_API_VERSION } from '../types.js';
import { StandaloneWsBridge } from './wsBridge.js';
import { StandaloneHttpBridge } from './httpBridge.js';
import { StandaloneDispatcher } from './dispatcher.js';

export interface StandaloneBridgeOptions {
  httpPort?: number;
  wsPort?: number;
  cwd?: string;
  onYield?: () => void;
  portFileMode?: 'default' | 'workspace-only' | 'none';
}

export class StandaloneBridge {
  private wsBridge?: StandaloneWsBridge;
  private httpBridge?: StandaloneHttpBridge;
  private token: string;
  private cwd: string;
  private writtenPortFiles: string[] = [];
  private portFilePayload?: string;
  private portFileHeartbeat?: NodeJS.Timeout;
  private signalHandler?: () => void;
  private exitHandler?: () => void;

  constructor(private options: StandaloneBridgeOptions = {}) {
    this.token = crypto.randomBytes(24).toString('hex');
    this.cwd = options.cwd || process.cwd();
  }

  async start(): Promise<{ httpPort: number; wsPort: number; token: string }> {
    // 1. Start WebSocket Bridge on 1978
    const wsBridge = new StandaloneWsBridge(this.options.wsPort ?? 1978);
    const wsPort = await wsBridge.start();
    this.wsBridge = wsBridge;

    // 2. Start Dispatcher
    const dispatcher = new StandaloneDispatcher({
      cwd: this.cwd,
      wsBridge,
    });
    wsBridge.onSaveFieldAsFile = (msg) => {
      void dispatcher.handleBrowserFieldSave(msg);
    };

    // 3. Start HTTP Bridge on 1977
    const httpBridge = new StandaloneHttpBridge({
      port: this.options.httpPort ?? 1977,
      token: this.token,
      dispatcher,
      onYield: async () => {
        await this.stop();
        if (this.options.onYield) {
          this.options.onYield();
        }
      },
    });
    const httpPort = await httpBridge.start();
    this.httpBridge = httpBridge;

    // 4. Write Port Files
    this.writePortFiles(httpPort);

    // Self-heal: older ScriptSync builds in an editor window blindly delete
    // the global port file on their own start/stop, leaving this healthy
    // bridge undiscoverable. Re-assert the files on a slow heartbeat.
    this.portFileHeartbeat = setInterval(() => this.reassertPortFiles(), 60_000);
    this.portFileHeartbeat.unref?.();

    // 5. Clean up on exit
    this.signalHandler = () => {
      void this.stop().finally(() => process.exit(0));
    };
    this.exitHandler = () => this.cleanPortFiles();
    process.once('SIGINT', this.signalHandler);
    process.once('SIGTERM', this.signalHandler);
    process.once('exit', this.exitHandler);

    return { httpPort, wsPort, token: this.token };
  }

  /**
   * Write a port descriptor. The file carries the bridge auth token, so it must
   * be owner-only — the extension has always written 0600 and the standalone
   * bridge used to fall back to the umask default (0644), leaving the token
   * readable by every account on the machine.
   */
  private writeDescriptor(target: string, payload: string): void {
    fs.writeFileSync(target, payload, { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600); // pre-existing file keeps its old mode otherwise
    } catch {
      /* best effort (Windows) */
    }
  }

  private writePortFiles(httpPort: number): void {
    const payload = JSON.stringify(
      {
        port: httpPort,
        token: this.token,
        pid: process.pid,
        apiVersion: AGENT_API_VERSION,
        startedAt: Date.now(),
        hostKind: 'standalone',
      },
      null,
      2
    );

    const portFileMode = this.options.portFileMode ?? 'default';

    // 1. Workspace port file: .vscode/sn-agent-port.json
    if (portFileMode !== 'none') {
      try {
        const vscodeDir = path.join(this.cwd, '.vscode');
        if (!fs.existsSync(vscodeDir)) {
          fs.mkdirSync(vscodeDir, { recursive: true });
        }
        const wsPortFile = path.join(vscodeDir, 'sn-agent-port.json');
        this.writeDescriptor(wsPortFile, payload);
        this.writtenPortFiles.push(wsPortFile);
      } catch {}
    }

    // 2. Global port file: ~/.sn-scriptsync/agent-port.json
    if (portFileMode === 'default') {
      try {
        const globalDir = path.join(os.homedir(), '.sn-scriptsync');
        if (!fs.existsSync(globalDir)) {
          fs.mkdirSync(globalDir, { recursive: true });
        }
        const globalPortFile = path.join(globalDir, 'agent-port.json');
        this.writeDescriptor(globalPortFile, payload);
        this.writtenPortFiles.push(globalPortFile);
      } catch {}
    }

    this.portFilePayload = payload;
  }

  /** Re-write any of our port files that went missing or lost their contents
   * to another process, leaving a file owned by another live bridge alone. */
  private reassertPortFiles(): void {
    if (!this.portFilePayload) return;
    const expected = JSON.parse(this.portFilePayload) as { port: number; token: string };
    for (const target of this.writtenPortFiles) {
      let rewrite = true;
      try {
        const data = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (data?.pid === process.pid) {
          // Ours — repair only if the contents drifted.
          rewrite = data.port !== expected.port || data.token !== expected.token;
        } else if (typeof data?.pid === 'number' && this.pidAlive(data.pid)) {
          rewrite = false; // a live foreign bridge owns this file — leave it
        }
      } catch {
        // Missing, unreadable or corrupt — rewrite.
      }
      if (rewrite) {
        try { this.writeDescriptor(target, this.portFilePayload); } catch {}
      }
    }
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // EPERM: the process exists but belongs to another user.
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }

  cleanPortFiles(): void {
    for (const p of this.writtenPortFiles) {
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          const data = JSON.parse(raw);
          // Only remove if this process owns it
          if (data.pid === process.pid) {
            fs.unlinkSync(p);
          }
        }
      } catch {}
    }
    this.writtenPortFiles = [];
  }

  async stop(): Promise<void> {
    if (this.portFileHeartbeat) {
      clearInterval(this.portFileHeartbeat);
      this.portFileHeartbeat = undefined;
    }
    if (this.signalHandler) {
      process.off('SIGINT', this.signalHandler);
      process.off('SIGTERM', this.signalHandler);
      this.signalHandler = undefined;
    }
    if (this.exitHandler) {
      process.off('exit', this.exitHandler);
      this.exitHandler = undefined;
    }
    this.cleanPortFiles();
    if (this.httpBridge) {
      await this.httpBridge.close();
      this.httpBridge = undefined;
    }
    if (this.wsBridge) {
      await this.wsBridge.close();
      this.wsBridge = undefined;
    }
  }
}
