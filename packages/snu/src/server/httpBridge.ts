import * as http from 'http';
import { StandaloneDispatcher } from './dispatcher.js';
import { AgentRequest, AgentResponse } from '../types.js';

export interface StandaloneHttpBridgeOptions {
  port?: number;
  token: string;
  dispatcher: StandaloneDispatcher;
  onYield?: () => Promise<void> | void;
}

export function httpStatusForCode(code?: string): number {
  switch (code) {
    case 'E_INVALID_PARAMS':
    case 'E_INVALID_REQUEST':
    case 'E_CONFIRM_REQUIRED':
    case 'E_MULTIPLE_MATCHES':
      return 400;
    case 'E_UNAUTHORIZED':
    case 'E_SECURITY':
      return 401;
    case 'E_PRO_REQUIRED':
      return 402;
    case 'E_USER_REJECTED':
      return 403;
    case 'E_UNKNOWN_COMMAND':
    case 'E_NOT_FOUND':
    case 'E_NO_TAB':
    case 'E_NO_ELEMENT':
      return 404;
    case 'E_REFERENCE_INTEGRITY':
    case 'E_DEBUGGER_BUSY':
    case 'E_REPLAY_DETECTED':
      return 409;
    case 'E_CDP_UNAVAILABLE':
      return 501;
    case 'E_INSTANCE_REQUIRED':
    case 'E_INSTANCE_NOT_FOUND':
      return 422;
    case 'E_DISABLED':
    case 'E_PAUSED':
      return 423;
    case 'E_REVIEW_UNAVAILABLE':
      return 424;
    case 'E_PARTIAL_FAILURE':
      return 207;
    case 'E_SCREENSHOT_PERMISSION':
      return 502;
    case 'E_TIMEOUT':
      return 504;
    case 'E_BROWSER_DISCONNECTED':
    case 'E_SERVER_NOT_RUNNING':
      return 503;
    case 'E_ACL':
    case 'E_TOKEN_EXPIRED':
      return 502;
    case 'E_INTERNAL':
    default:
      return 500;
  }
}

export class StandaloneHttpBridge {
  private server?: http.Server;
  private port: number;
  private token: string;
  private dispatcher: StandaloneDispatcher;
  private onYield?: () => Promise<void> | void;

  constructor(opts: StandaloneHttpBridgeOptions) {
    this.port = opts.port ?? 1977;
    this.token = opts.token;
    this.dispatcher = opts.dispatcher;
    this.onYield = opts.onYield;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        // Set CORS & Content-Type
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // 1. Health check
        if (req.method === 'GET' && req.url === '/api/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'success',
              apiVersion: 8,
              hostKind: 'standalone',
              pid: process.pid,
              commands: [
                'check_connection',
                'get_instance_info',
                'list_instances',
                'get_capabilities',
                'query_records',
                'get_record',
                'update_record',
                'create_artifact',
                'delete_record',
                'get_table_metadata',
                'code_search',
                'run_background_script',
                'get_form_state',
                'set_field',
                'run_ui_action',
                'navigate',
                'take_screenshot',
              ],
            })
          );
          return;
        }

        // 2. Command Dispatch & Handover
        if (req.method === 'POST' && (req.url === '/api' || req.url === '/api/yield')) {
          const auth = req.headers['x-agent-token'];
          if (auth !== this.token) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'E_UNAUTHORIZED', error: 'Invalid or missing X-Agent-Token' }));
            return;
          }

          let body = '';
          let parsedRequest: AgentRequest | undefined;

          req.on('data', (chunk) => (body += chunk));

          req.on('close', () => {
            if (!res.writableEnded && parsedRequest?.id) {
              this.dispatcher.cancel(parsedRequest.id, 'HTTP_REQUEST_CLOSED');
            }
          });

          req.on('end', async () => {
            try {
              const parsed: AgentRequest = body ? JSON.parse(body) : { id: 'yield', command: 'yield' };
              parsedRequest = parsed;

              // Check for Handover / Yield request
              if (parsed.command === 'yield' || req.url === '/api/yield') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'success', result: { yielded: true } }));
                if (this.onYield) {
                  setTimeout(() => this.onYield?.(), 50);
                }
                return;
              }

              const response = await this.dispatcher.dispatch(parsed);
              const status = response.status === 'error' ? httpStatusForCode(response.code) : 200;
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response));
            } catch (err: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'error', code: 'E_INTERNAL', error: err?.message || String(err) }));
            }
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', code: 'E_NOT_FOUND', error: 'Not found' }));
      });

      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && this.port === 1977) {
          // Fall back to ephemeral port
          server.listen(0, '127.0.0.1');
        } else {
          reject(err);
        }
      });

      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve(this.port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = undefined;
          resolve();
        });
      });
    }
  }

  getPort(): number {
    return this.port;
  }
}
