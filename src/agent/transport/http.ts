import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AddressInfo } from 'net';
import { dispatchAgentCommand } from '../dispatcher';
import { httpStatusForCode } from '../errors';
import { AgentRequest, AgentResponse } from '../types';
import { commandNames } from '../commands';
import { writePortFile, deletePortFile, AGENT_API_VERSION, AGENT_API_FIXED_PORT } from '../portFile';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB – attachments push this up

/**
 * The canonical two-line connect instruction. Static on purpose: the fixed
 * port and the global port file make it paste-anywhere (global CLAUDE.md,
 * AGENTS.md, a Devin playbook, any system prompt).
 */
export const AGENT_CONNECT_SNIPPET = [
	'ScriptSync Agent API (SN Utils / sn-scriptsync): drive ServiceNow from this machine.',
	`1. GET http://127.0.0.1:${AGENT_API_FIXED_PORT}/api/instructions for full usage docs (no auth). If that port does not answer, read the actual port from ~/.sn-scriptsync/agent-port.json.`,
	'2. Auth: read the token from ~/.sn-scriptsync/agent-port.json and send it as the X-Agent-Token header.',
	'3. Try it: POST http://127.0.0.1:<port>/api with body {"command":"check_connection"}.',
].join('\n');

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

function sendMarkdown(res: http.ServerResponse, body: string) {
	const payload = Buffer.from(body, 'utf8');
	res.writeHead(200, {
		'content-type': 'text/markdown; charset=utf-8',
		'content-length': payload.length,
		'cache-control': 'no-store',
	});
	res.end(payload);
}

/** Only allow plain skill-folder names — no separators, no traversal. */
function safeSkillName(name: string): boolean {
	return /^[a-z0-9-]+$/i.test(name);
}

export async function startAgentHttpServer(opts: {
	extensionVersion?: string;
	onLog?: (msg: string) => void;
	/** Absolute path to the packaged agentrules/ folder (instructions + skills).
	 * When set, the server serves its own always-current docs. */
	docsDir?: string;
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

			// Self-describing docs – no auth (shipped documentation, no secrets).
			// The connect snippet points here so instructions can never drift
			// from the installed extension version.
			if (req.method === 'GET' && url.pathname === '/api/instructions' && opts.docsDir) {
				try {
					const core = fs.readFileSync(path.join(opts.docsDir, 'agentinstructions.md'), 'utf8');
					return sendMarkdown(res, `${AGENT_CONNECT_SNIPPET}\n\nOn-demand skills: GET /api/skills (index) and /api/skills/<name> (full skill).\n\n---\n\n${core}`);
				} catch {
					return sendJson(res, 404, { status: 'error', code: 'E_NOT_FOUND', error: 'Instructions not available in this install' });
				}
			}
			if (req.method === 'GET' && url.pathname === '/api/skills' && opts.docsDir) {
				try {
					const manifest = JSON.parse(fs.readFileSync(path.join(opts.docsDir, 'skills', '_skills.json'), 'utf8'));
					return sendJson(res, 200, { status: 'success', skills: manifest });
				} catch {
					return sendJson(res, 404, { status: 'error', code: 'E_NOT_FOUND', error: 'Skill manifest not available in this install' });
				}
			}
			if (req.method === 'GET' && url.pathname.startsWith('/api/skills/') && opts.docsDir) {
				const name = url.pathname.slice('/api/skills/'.length);
				if (!safeSkillName(name)) {
					return sendJson(res, 400, { status: 'error', code: 'E_INVALID_REQUEST', error: 'Invalid skill name' });
				}
				try {
					const skill = fs.readFileSync(path.join(opts.docsDir, 'skills', name, 'SKILL.md'), 'utf8');
					return sendMarkdown(res, skill);
				} catch {
					return sendJson(res, 404, { status: 'error', code: 'E_NOT_FOUND', error: `No such skill: ${name}` });
				}
			}

			if (!authOk(req, token)) {
				return sendJson(res, 401, {
					status: 'error',
					code: 'E_UNAUTHORIZED',
					error: 'Missing or invalid X-Agent-Token header. Read ~/.sn-scriptsync/agent-port.json (or <workspace>/.vscode/sn-agent-port.json) for the current token.',
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

	// Prefer the fixed port so the connect instruction is a static sentence;
	// fall back to an ephemeral port when it's taken (second window, another
	// app). The port files always carry the actual port either way.
	const listenOn = (port: number) => new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	try {
		await listenOn(AGENT_API_FIXED_PORT);
	} catch (e: any) {
		log(`[agent-http] port ${AGENT_API_FIXED_PORT} unavailable (${e?.code || e?.message || e}), falling back to an ephemeral port`);
		await listenOn(0);
	}

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
