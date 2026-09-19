// Mirrored in packages/snu/src/server/helperConnection.ts for the standalone build.
interface HelperSocket {
	readyState: number;
	on(event: string, listener: () => void): unknown;
	off(event: string, listener: () => void): unknown;
	ping(): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
	send(payload: string): void;
}

/** Close code for a helper that was replaced by a newer helper tab. */
export const HELPER_REPLACED = 4001;
/** Close code for an automatic reconnect that found another helper tab active. */
export const HELPER_STANDBY = 4002;
const REPLACED_GRACE_MS = 2_000;

/**
 * Helper tabs mark an automatic reconnect with `?resume=1`. Only a connection
 * without it (a helper tab that was just opened, or the user pressing
 * reconnect) may take over from a live helper. Two helper tabs, for example one
 * per Chrome profile, otherwise replace each other forever: each one reconnects
 * the moment it is replaced.
 */
export function isResumeRequest(url: string | undefined): boolean {
	return /[?&]resume=1(&|$)/.test(url || '');
}

/** One helper owns the session. Old sockets cannot clear a replacement's state. */
export class HelperConnection<T extends HelperSocket> {
	current?: T;
	private cleanup?: () => void;

	constructor(private disconnected: () => void, private heartbeatMs = 30_000) {}

	get connected(): boolean { return this.current?.readyState === 1; }
	isActive(socket: T): boolean { return this.current === socket; }

	/**
	 * Turn away an automatic reconnect while another helper is live. Returns
	 * true when the socket was refused; the caller must then not accept it.
	 */
	refuseResume(socket: T, url: string | undefined): boolean {
		if (!isResumeRequest(url) || !this.connected || this.isActive(socket)) return false;
		try { socket.close(HELPER_STANDBY, 'Another helper tab is active'); } catch { /* already closed */ }
		return true;
	}

	accept(socket: T): void {
		if (this.isActive(socket)) return;
		// Reject old requests and forget old permissions before accepting the new session.
		this.stop(HELPER_REPLACED, 'Replaced by a newer helper tab');
		this.current = socket;
		let alive = true;
		const pong = () => { alive = true; };
		const closed = () => {
			if (!this.isActive(socket)) return;
			this.cleanup?.();
			this.cleanup = undefined;
			this.current = undefined;
			this.disconnected();
		};
		const timer = setInterval(() => {
			if (!this.isActive(socket)) return;
			if (!alive || !this.connected) { this.stop(); return; }
			alive = false;
			try { socket.ping(); } catch { this.stop(); }
		}, this.heartbeatMs);
		timer.unref();
		socket.on('pong', pong);
		socket.on('close', closed);
		this.cleanup = () => {
			clearInterval(timer);
			socket.off('pong', pong);
			socket.off('close', closed);
		};
	}

	send(payload: string): void {
		if (this.connected) this.current!.send(payload);
	}

	/**
	 * Drop the current helper. With a close code the helper is told why, so a
	 * replaced tab can stand by instead of reconnecting straight away; it is
	 * still terminated if it has not closed after a short grace period.
	 */
	stop(code?: number, reason?: string): void {
		const socket = this.current;
		this.cleanup?.();
		this.cleanup = undefined;
		this.current = undefined;
		if (!socket) return;
		this.disconnected();
		if (code === undefined) {
			try { socket.terminate(); } catch { /* already closed */ }
			return;
		}
		try { socket.close(code, reason); } catch { /* already closed */ }
		const timer = setTimeout(() => {
			if (socket.readyState !== 3) { try { socket.terminate(); } catch { /* already closed */ } }
		}, REPLACED_GRACE_MS);
		timer.unref();
	}
}
