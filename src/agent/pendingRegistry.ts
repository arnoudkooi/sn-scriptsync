import { AgentError, AgentErrorCode } from './errors';

export interface PendingEntry {
	id: string;
	command: string;
	instanceFolder: string;
	createdAt: number;
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();

export interface RegisterOptions {
	id: string;
	command: string;
	instanceFolder: string;
	timeoutMs: number;
}

export function register<T = any>(opts: RegisterOptions): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			if (pending.delete(opts.id)) {
				reject(new AgentError('E_TIMEOUT', `Timed out waiting for browser response (${opts.timeoutMs}ms)`));
			}
		}, opts.timeoutMs);

		pending.set(opts.id, {
			id: opts.id,
			command: opts.command,
			instanceFolder: opts.instanceFolder,
			createdAt: Date.now(),
			resolve,
			reject,
			timer,
		});
	});
}

export function resolve(id: string, value: any): boolean {
	const entry = pending.get(id);
	if (!entry) return false;
	clearTimeout(entry.timer);
	pending.delete(id);
	entry.resolve(value);
	return true;
}

export function reject(id: string, code: AgentErrorCode, message: string, details?: any): boolean {
	const entry = pending.get(id);
	if (!entry) return false;
	clearTimeout(entry.timer);
	pending.delete(id);
	entry.reject(new AgentError(code, message, details));
	return true;
}

export function has(id: string): boolean {
	return pending.has(id);
}

export function get(id: string): PendingEntry | undefined {
	return pending.get(id);
}

/** Fail every pending request belonging to the given instance folder. */
export function rejectForInstance(instanceFolder: string, code: AgentErrorCode, message: string): number {
	let count = 0;
	for (const entry of Array.from(pending.values())) {
		if (entry.instanceFolder === instanceFolder) {
			if (reject(entry.id, code, message)) count++;
		}
	}
	return count;
}

/** Fail everything and clear. Called on deactivate. */
export function rejectAll(code: AgentErrorCode, message: string): void {
	for (const entry of Array.from(pending.values())) {
		reject(entry.id, code, message);
	}
}

export function size(): number {
	return pending.size;
}
