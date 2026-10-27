/**
 * Confirmed saves.
 *
 * A file used to leave Pending Saves the moment its save was handed to the
 * helper tab. A save that failed on the instance (expired session, ACL) was
 * gone from the queue before the error came back, and nothing told VS Code
 * which file it was. Now every editor save carries a syncId, the helper tab
 * answers it with a saveResult (ok or not), and the file stays in the queue,
 * shown as syncing, until that answer arrives.
 *
 * The answer is matched to the revision that was sent, not just to the file:
 * an edit made while a save is in flight is never removed by the earlier
 * acknowledgement. A reply for an unknown or already answered syncId is ignored.
 *
 * Pure logic, no vscode import, so node --test can cover it.
 */
import { createHash } from 'crypto';

/** How a queued file is shown in Pending Saves. */
export type SyncFileState = 'pending' | 'syncing' | 'failed' | 'unconfirmed';

/** Where a save writes: one record's fields on one instance. */
export interface SyncTarget {
	instance: string;
	table: string;
	sysId: string;
	fields: string[];
}

export interface SubmittedFile {
	filePath: string;
	/** The content that was sent, read from disk at dispatch. */
	content: string;
}

interface InFlightFile extends SubmittedFile {
	revision: string;
}

export interface InFlightSave {
	syncId: string;
	target: SyncTarget;
	files: InFlightFile[];
	submittedAt: number;
}

export type FileOutcome =
	/** The instance holds the content that was sent; the file can leave the queue. */
	| 'confirmed'
	/** The save succeeded, but the file changed since it was sent: the newer change stays pending. */
	| 'superseded'
	/** The instance refused the save; the file stays, held for the user. */
	| 'failed';

export interface FileResult {
	filePath: string;
	outcome: FileOutcome;
	submittedContent: string;
}

export interface SaveResult {
	syncId: string;
	ok: boolean;
	target: SyncTarget;
	files: FileResult[];
}

export function revisionOf(content: string): string {
	return createHash('sha1').update(content ?? '', 'utf8').digest('hex');
}

function sameDestination(a: SyncTarget, b: SyncTarget): boolean {
	if (a.instance !== b.instance || a.table !== b.table || a.sysId !== b.sysId) return false;
	// Unknown fields on either side count as the whole record.
	if (!a.fields.length || !b.fields.length) return true;
	return a.fields.some(field => b.fields.includes(field));
}

export class SyncTracker {
	private readonly inFlight = new Map<string, InFlightSave>();
	// Only suppress delayed notifications of a recently confirmed revision.
	// This is not a durable claim about the instance: another client can edit it.
	private readonly confirmed = new Map<string, { revision: string; at: number }>();
	private readonly confirmationWindowMs = 60_000;
	private seq = 0;

	constructor(private readonly now: () => number = Date.now) {}

	get size(): number {
		return this.inFlight.size;
	}

	newSyncId(): string {
		this.seq += 1;
		return `sync_${this.now().toString(36)}_${this.seq.toString(36)}`;
	}

	submit(syncId: string, target: SyncTarget, files: SubmittedFile[]): InFlightSave {
		for (const file of files) this.forgetConfirmation(file.filePath);
		const save: InFlightSave = {
			syncId,
			target: { ...target, fields: [...target.fields] },
			files: files.map(file => ({ ...file, revision: revisionOf(file.content) })),
			submittedAt: this.now(),
		};
		this.inFlight.set(syncId, save);
		return save;
	}

	forgetConfirmation(filePath: string): void {
		this.confirmed.delete(filePath);
	}

	/** A different revision invalidates the guard, including a later revert. */
	isRecentlyConfirmed(filePath: string, content: string): boolean {
		const saved = this.confirmed.get(filePath);
		if (!saved) return false;
		if (this.isInFlight(filePath) || this.now() - saved.at >= this.confirmationWindowMs || revisionOf(content) !== saved.revision) {
			this.forgetConfirmation(filePath);
			return false;
		}
		return true;
	}

	private rememberConfirmation(filePath: string, revision: string) {
		const now = this.now();
		for (const [file, saved] of this.confirmed) {
			if (now - saved.at >= this.confirmationWindowMs) this.confirmed.delete(file);
		}
		// Bound memory even when a large workspace syncs many files at once.
		if (this.confirmed.size >= 1000) this.confirmed.delete(this.confirmed.keys().next().value);
		this.confirmed.set(filePath, { revision, at: now });
	}

	isInFlight(filePath: string): boolean {
		for (const save of this.inFlight.values()) {
			if (save.files.some(file => file.filePath === filePath)) return true;
		}
		return false;
	}

	/** Every file that is waiting for an answer, oldest save first. */
	busyFiles(): string[] {
		const files: string[] = [];
		for (const save of this.inFlight.values()) {
			for (const file of save.files) if (!files.includes(file.filePath)) files.push(file.filePath);
		}
		return files;
	}

	/** True while a save to the same record fields is still unanswered. */
	destinationBusy(target: SyncTarget): boolean {
		for (const save of this.inFlight.values()) {
			if (sameDestination(save.target, target)) return true;
		}
		return false;
	}

	/**
	 * Apply the helper tab's answer. Returns nothing for a syncId that is not
	 * in flight (unknown, expired, or answered before), so a duplicate or stale
	 * reply changes nothing.
	 */
	resolve(syncId: string, ok: boolean, currentContent: (filePath: string) => string | undefined): SaveResult | undefined {
		const save = this.inFlight.get(syncId);
		if (!save) return undefined;
		this.inFlight.delete(syncId);
		const files = save.files.map<FileResult>(file => {
			if (!ok) return { filePath: file.filePath, outcome: 'failed', submittedContent: file.content };
			const current = currentContent(file.filePath);
			// A file that is gone cannot hold a newer change.
			const unchanged = current === undefined || revisionOf(current) === file.revision;
			if (current !== undefined && unchanged) this.rememberConfirmation(file.filePath, file.revision);
			return { filePath: file.filePath, outcome: unchanged ? 'confirmed' : 'superseded', submittedContent: file.content };
		});
		return { syncId, ok, target: save.target, files };
	}

	/** Give up waiting for one save (timeout). */
	expire(syncId: string): InFlightSave | undefined {
		const save = this.inFlight.get(syncId);
		if (save) this.inFlight.delete(syncId);
		return save;
	}

	/** Give up waiting for every save (helper disconnected, bridge stopped). */
	drain(): InFlightSave[] {
		const saves = [...this.inFlight.values()];
		this.inFlight.clear();
		this.confirmed.clear();
		return saves;
	}

	/** Forget everything without reporting (queue cleared by the user). */
	clear(): void {
		this.inFlight.clear();
		this.confirmed.clear();
	}
}
