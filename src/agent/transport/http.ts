import * as http from 'http';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';
import { dispatchAgentCommand } from '../dispatcher';
import { httpStatusForCode } from '../errors';
import { AgentRequest, AgentResponse } from '../types';
import { commandNames } from '../commands';
import { writePortFile, deletePortFile, AGENT_API_VERSION } from '../portFile';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB – attachments push this up

export interface HttpServerState {
	server: http.Server;
	port: number;
	token: string;
	portFilePath?: string;
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			if (chunks.length === 0) return resolve(undefined);
			const raw = Buffer.concat(chunks).toString('utf8');
			try {
				resolve(raw ? JSON.parse(raw) : undefined);
			} catch (e: any) {
				reject(new Error(`Invalid JSON: ${e?.message || e}`));
			}
		});
		req.on('error', reject);
	});
}

function sendJson(res: http.ServerResponse, status: number, body: any) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload),
		'cache-control': 'no-store',
	});
	res.end(payload);
}

function authOk(req: http.IncomingMessage, token: string): boolean {
	const header = req.headers['x-agent-token'];
	if (Array.isArray(header)) return header[0] === token;
	return header === token;
}

export async function startAgentHttpServer(opts: {
	extensionVersion?: string;
	onLog?: (msg: string) => void;
}): Promise<HttpServerState> {
	const token = crypto.randomBytes(16).toString('hex');
	const log = opts.onLog || (() => { /* noop */ });

	const server = http.createServer(async (req, res) => {
		try {
			if (!req.url) return sendJson(res, 404, { status: 'error', code: 'E_INVALID_REQUEST', error: 'No URL' });

			const url = new URL(req.url, 'http://127.0.0.1');

			// Health endpoint – no auth, used by agents to discover whether the
			// extension is up and to read feature flags.
			if (req.method === 'GET' && url.pathname === '/api/health') {
				return sendJson(res, 200, {
					status: 'success',
					apiVersion: AGENT_API_VERSION,
					commands: commandNames(),
					pid: process.pid,
				});
			}

			if (!authOk(req, token)) {
				return sendJson(res, 401, {
					status: 'error',
					code: 'E_UNAUTHORIZED',
					error: 'Missing or invalid X-Agent-Token header. Read .vscode/sn-agent-port.json for the current token.',
				});
			}

			if (req.method === 'POST' && url.pathname === '/api') {
				let body: any;
				try {
					body = await readJsonBody(req);
				} catch (e: any) {
					log(`[agent-http] bad request body: ${e?.message || e}`);
					return sendJson(res, 400, {
						status: 'error', code: 'E_INVALID_REQUEST', error: 'Invalid or oversized JSON body',
					});
				}
				if (!body || typeof body !== 'object') {
					return sendJson(res, 400, {
						status: 'error', code: 'E_INVALID_REQUEST', error: 'Body must be a JSON object',
					});
				}

				// Generate an id if the agent omitted one – makes curl quickstart trivial.
				if (!body.id) body.id = `http_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

				const response: AgentResponse = await dispatchAgentCommand(body as AgentRequest);
				const status = response.status === 'success' ? 200 : httpStatusForCode(response.code);
				return sendJson(res, status, response);
			}

			sendJson(res, 404, { status: 'error', code: 'E_UNKNOWN_COMMAND', error: `No route for ${req.method} ${url.pathname}` });
		} catch (e: any) {
			log(`[agent-http] internal error: ${e?.stack || e?.message || e}`);
			try { sendJson(res, 500, { status: 'error', code: 'E_INTERNAL', error: 'Internal error' }); } catch { /* ignore */ }
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});

	const address = server.address() as AddressInfo | null;
	const port = address?.port ?? 0;

	const portFilePath = writePortFile({
		port,
		token,
		pid: process.pid,
		extensionVersion: opts.extensionVersion,
	});

	log(`[agent-http] listening on 127.0.0.1:${port}, port file: ${portFilePath || 'n/a'}`);
	return { server, port, token, portFilePath };
}

export function stopAgentHttpServer(state: HttpServerState | undefined): Promise<void> {
	return new Promise((resolve) => {
		deletePortFile();
		if (!state) return resolve();
		try {
			state.server.close(() => resolve());
		} catch {
			resolve();
		}
	});
}
