/**
 * Bridge lifecycle state machine.
 *
 * The 2026-08-29 incident came from `startServers()` being re-entrant: a second
 * call re-registered editor commands and raced the transport binds, leaving
 * listeners up while the bridge was only half-alive. This module owns the one
 * authoritative answer to "is the bridge running, and may I start it now?", and
 * serialises every start/stop so those paths cannot interleave.
 *
 * Deliberately host-agnostic — no `vscode` import, no transport knowledge. The
 * caller injects start/stop hooks, which is what makes the lifecycle testable
 * without an extension host.
 */

export type LifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface LifecycleTransports {
	/** Bind the HTTP + WebSocket listeners. Must reject if either fails. */
	start(): Promise<void>;
	/** Release the listeners. Must be safe to call from a partial start. */
	stop(): Promise<void>;
}

export interface BridgeLifecycleOptions {
	transports: LifecycleTransports;
	log?: (message: string) => void;
	onStateChange?: (next: LifecycleState, previous: LifecycleState) => void;
}

export interface StartOutcome {
	state: LifecycleState;
	/** True when this call actually ran the transport start. */
	performed: boolean;
	/** True when the bridge was already up (or came up via a start this call joined). */
	alreadyRunning: boolean;
}

export class BridgeLifecycle {
	private _state: LifecycleState = 'stopped';
	private startInflight?: Promise<StartOutcome>;
	private transition?: Promise<unknown>;
	private _lastError?: Error;

	constructor(private readonly options: BridgeLifecycleOptions) {}

	get state(): LifecycleState {
		return this._state;
	}

	/** True only in the fully-running state — never during a transition. */
	get isRunning(): boolean {
		return this._state === 'running';
	}

	get lastError(): Error | undefined {
		return this._lastError;
	}

	/**
	 * Start the bridge, or hand back the healthy one that is already running.
	 *
	 * Every branch below decides synchronously, before the first await, so two
	 * calls in the same tick cannot both reach the transport start.
	 */
	start(): Promise<StartOutcome> {
		if (this._state === 'running') {
			return Promise.resolve({ state: 'running', performed: false, alreadyRunning: true });
		}

		// A start is already in flight: join it rather than racing a second bind.
		if (this._state === 'starting' && this.startInflight) {
			return this.startInflight.then((outcome) => ({
				...outcome,
				performed: false,
				alreadyRunning: true,
			}));
		}

		// Mid-shutdown: queue behind it so we never bind a port the stop is
		// still releasing.
		if (this._state === 'stopping' && this.transition) {
			return this.transition.catch(() => undefined).then(() => this.start());
		}

		return this.beginStart();
	}

	/**
	 * Stop the bridge. Safe from any state, including a failed or partial start
	 * (where one listener bound and the other did not).
	 */
	stop(): Promise<void> {
		if (this._state === 'stopped') return Promise.resolve();

		if (this._state === 'stopping' && this.transition) {
			return this.transition.then(() => undefined, () => undefined);
		}

		// Let an in-flight start settle first, then tear down whatever it left.
		if (this._state === 'starting' && this.startInflight) {
			return this.startInflight
				.catch(() => undefined)
				.then(() => this.stop());
		}

		return this.beginStop();
	}

	private beginStart(): Promise<StartOutcome> {
		this.setState('starting');
		this._lastError = undefined;

		const run = (async (): Promise<StartOutcome> => {
			try {
				await this.options.transports.start();
				this.setState('running');
				return { state: 'running', performed: true, alreadyRunning: false };
			} catch (err: any) {
				this._lastError = err instanceof Error ? err : new Error(String(err));
				this.log(`start failed: ${this._lastError.message}`);
				// A failed start can still have bound one of the two listeners.
				// Release whatever came up so the next attempt is a clean bind.
				try {
					await this.options.transports.stop();
				} catch (cleanupErr: any) {
					this.log(`cleanup after failed start also failed: ${cleanupErr?.message || cleanupErr}`);
				}
				this.setState('failed');
				throw this._lastError;
			} finally {
				this.startInflight = undefined;
				this.transition = undefined;
			}
		})();

		this.startInflight = run;
		// Swallow here only to keep the shared transition handle unrejected; the
		// caller still sees the rejection through `run`.
		this.transition = run.catch(() => undefined);
		return run;
	}

	private beginStop(): Promise<void> {
		this.setState('stopping');

		const run = (async (): Promise<void> => {
			try {
				await this.options.transports.stop();
			} catch (err: any) {
				// A stop that throws must not strand the machine in 'stopping' —
				// the ports are as released as we can make them either way.
				this.log(`stop error (continuing to stopped): ${err?.message || err}`);
			} finally {
				this.setState('stopped');
				this.transition = undefined;
			}
		})();

		this.transition = run;
		return run;
	}

	private setState(next: LifecycleState): void {
		const previous = this._state;
		if (previous === next) return;
		this._state = next;
		this.log(`state ${previous} -> ${next}`);
		try {
			this.options.onStateChange?.(next, previous);
		} catch (err: any) {
			this.log(`onStateChange listener threw: ${err?.message || err}`);
		}
	}

	private log(message: string): void {
		this.options.log?.(`[lifecycle] ${message}`);
	}
}
