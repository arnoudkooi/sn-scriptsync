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
}

export class StandaloneBridge {
  private wsBridge?: StandaloneWsBridge;
  private httpBridge?: StandaloneHttpBridge;
  private token: string;
  private cwd: string;
  private writtenPortFiles: string[] = [];

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
    const cleanup = () => {
      this.cleanPortFiles();
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('exit', cleanup);

    return { httpPort, wsPort, token: this.token };
  }

  private writePortFiles(httpPort: number): void {
    const payload = JSON.stringify(
      {
        port: httpPort,
        token: this.token,
        pid: process.pid,
        apiVersion: 8,
        startedAt: Date.now(),
        hostKind: 'standalone',
      },
      null,
      2
    );

    // 1. Workspace port file: .vscode/sn-agent-port.json
    try {
      const vscodeDir = path.join(this.cwd, '.vscode');
      if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
      }
      const wsPortFile = path.join(vscodeDir, 'sn-agent-port.json');
      fs.writeFileSync(wsPortFile, payload);
      this.writtenPortFiles.push(wsPortFile);
    } catch {}

    // 2. Global port file: ~/.sn-scriptsync/agent-port.json
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
