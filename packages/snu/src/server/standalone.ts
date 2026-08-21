import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
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

  private writePortFiles(httpPort: number): void {
    const payload = JSON.stringify(
      {
        port: httpPort,
        token: this.token,
        pid: process.pid,
        apiVersion: 9,
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
        fs.writeFileSync(wsPortFile, payload);
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
        fs.writeFileSync(globalPortFile, payload);
        this.writtenPortFiles.push(globalPortFile);
      } catch {}
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
