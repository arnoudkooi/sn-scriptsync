/**
 * Background script results: structured output and the retry rule.
 *
 * Pure logic, no imports: the standalone bridge mirrors this file verbatim
 * (packages/snu/src/server/backgroundScript.ts) and the bridge parity test
 * fails when the copies differ. Both hosts run backgroundScriptVectors.ts.
 *
 * `output` stays the raw text the instance returned. Callers such as
 * delete_application parse markers out of it, so it is never rewritten; the
 * structured fields are added next to it.
 */

export interface ParsedScriptOutput {
	/** Lines printed with gs.print / gs.info, without the `*** Script: ` prefix. */
	stdout: string;
	warnings: string[];
	errors: string[];
	/** Everything else the instance logged during the run ([CacheFlushLog] and the like). */
	logLines: string[];
	/** sys_script_execution_history sys_id from the result link, when present. */
	executionId: string | null;
	status: 'completed' | 'failed';
}

export interface ScriptResult extends ParsedScriptOutput {
	executed: true;
	output: string;
}

/** A helper reply to agentRunBackgroundScript, or a rejection mapped onto one. */
export interface ScriptReply {
	success?: boolean;
	code?: string;
	/** The helper's verdict, in details like its record-batch replies. */
	details?: { notStarted?: boolean } | null;
	output?: string;
}

const SCRIPT_PREFIX = '*** Script: ';
const EXECUTION_ID = /sys_script_execution_history\.do\?sys_id=([0-9a-f]{32})/i;
const ERROR_START = /^(Evaluator:|Script execution error:|Javascript compiler exception|org\.mozilla\.javascript\.|com\.glide\.\S*Exception)|RhinoEcmaError|EcmaError:/;
const ERROR_CONTINUATION = /^(\s+\S|==>)/;
const WARNING = /^(\*\*\* )?WARNING\b|^Warning:|^Security restricted/i;

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&#x27;/gi, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

/** The printed part of the result page: the <PRE> block, or the whole text without one. */
function printedBody(raw: string): string {
	const pre = /<PRE>([\s\S]*?)(<\/PRE>|$)/i.exec(raw);
	return pre ? pre[1] : raw;
}

export function parseScriptOutput(raw: string): ParsedScriptOutput {
	const text = typeof raw === 'string' ? raw : '';
	const idMatch = EXECUTION_ID.exec(text);
	const lines = printedBody(text)
		.split(/<BR\s*\/?>|\r?\n/i)
		.map((line) => decodeEntities(line.replace(/<[^>]*>/g, '')).replace(/\s+$/, ''))
		.filter((line) => line.trim() !== '');

	const stdout: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const logLines: string[] = [];
	let inError = false;
	for (const line of lines) {
		if (inError && ERROR_CONTINUATION.test(line)) {
			errors[errors.length - 1] += '\n' + line;
			continue;
		}
		inError = false;
		if (line.startsWith(SCRIPT_PREFIX)) stdout.push(line.slice(SCRIPT_PREFIX.length));
		else if (ERROR_START.test(line)) { errors.push(line); inError = true; }
		else if (WARNING.test(line)) warnings.push(line);
		else logLines.push(line);
	}
	return {
		stdout: stdout.join('\n'),
		warnings,
		errors,
		logLines,
		executionId: idMatch ? idMatch[1].toLowerCase() : null,
		status: errors.length > 0 ? 'failed' : 'completed',
	};
}

export function scriptResult(output: unknown): ScriptResult {
	const raw = typeof output === 'string' ? output : '';
	return { executed: true, output: raw, ...parseScriptOutput(raw) };
}

/**
 * True only when the reply proves the script never ran, so running it again
 * after a session-token refresh cannot execute it twice.
 *
 * - A helper that knows the field answers it explicitly; its answer wins.
 * - Older helpers answer E_UNAUTHORIZED only from the branch where
 *   sys.scripts.do refused the request instead of running it.
 * - The bare page text "not authorized" is that same refusal, as a reply.
 *
 * Anything else, including E_ACL, an inferred code, a message that merely
 * mentions authorization, or a timeout, is not proof and is never retried.
 */
export function scriptNotStarted(reply: ScriptReply | null | undefined): boolean {
	if (!reply) return false;
	const verdict = reply.details?.notStarted;
	if (typeof verdict === 'boolean') return verdict;
	return isAuthRefusal(reply);
}

function isAuthRefusal(reply: ScriptReply): boolean {
	if (reply.success === false) return reply.code === 'E_UNAUTHORIZED';
	return typeof reply.output === 'string' && reply.output.trim().toLowerCase() === 'not authorized';
}

/**
 * Refresh the session token and run the script once more only when it
 * provably did not run AND the instance refused the session. A script that
 * never started for another reason (a blocked gate, a missing parameter)
 * gains nothing from a new token.
 */
export function retryAfterTokenRefresh(reply: ScriptReply | null | undefined): boolean {
	return !!reply && scriptNotStarted(reply) && isAuthRefusal(reply);
}
