/**
 * Which saves may push a file to an instance.
 *
 * A file save alone does not show that the user meant to update ServiceNow.
 * VS Code reports TextDocumentSaveReason.Manual for Ctrl+S, but also for Save
 * All, for document.save() from any extension, and for every file a rename
 * auto-saves under files.refactoring.autoSave, open or not
 * (scripts/test-save-paths.mjs reproduces this; SNU0000010184).
 *
 * So the push is tied to a gesture instead: Ctrl+S / Cmd+S in a synced file
 * runs the Save & Sync command, which marks that one document before saving.
 * A save that arrives without a mark goes to Pending Saves and is held until
 * the user syncs it there.
 *
 * Pure logic, no vscode import, so scripts can unit test it.
 */

/**
 * What started a push, sent to the helper tab with the request.
 * - save_command:    Save & Sync on one file (Ctrl+S / Cmd+S in a synced file)
 * - queue_sync:      the user synced from Pending Saves (Sync Now, per-file ✓)
 * - queue_auto_sync: the queue timer (External Changes: Sync Delay above 0)
 * - agent_sync:      an agent asked to flush the queue (sync_now)
 * The helper cannot verify this value. It describes what the editor saw; it is
 * not authentication.
 */
export type SyncIntent = 'save_command' | 'queue_sync' | 'queue_auto_sync' | 'agent_sync';

/** Only a sync the user started from Pending Saves may push held saves. */
export function intentIncludesHeld(intent: SyncIntent): boolean {
	return intent === 'queue_sync';
}

/**
 * One-shot marks set by Save & Sync just before it saves. A mark lives only for
 * the duration of that save; an expired mark counts as absent.
 */
export class ExplicitSaveIntents {
	private readonly marks = new Map<string, number>();

	constructor(private readonly ttlMs = 30_000, private readonly now: () => number = Date.now) {}

	mark(key: string): void {
		this.marks.set(key, this.now());
	}

	/** Consume the mark. True when it existed and had not expired. */
	take(key: string): boolean {
		const at = this.marks.get(key);
		this.marks.delete(key);
		return at !== undefined && this.now() - at <= this.ttlMs;
	}

	has(key: string): boolean {
		const at = this.marks.get(key);
		return at !== undefined && this.now() - at <= this.ttlMs;
	}

	clear(key: string): void {
		this.marks.delete(key);
	}
}

export type EditorSaveDecision =
	/** Not a synced ScriptSync file, or ScriptSync is not running. */
	| 'ignore'
	/** A staged agent review file: stays in the queue for per-file approval. */
	| 'hold_review'
	/** Saved through Save & Sync: push this file now. */
	| 'push'
	/** Saved some other way: add to Pending Saves, held from auto sync. */
	| 'queue_held';

export function decideEditorSave(input: { syncable: boolean; reviewStaged: boolean; explicit: boolean }): EditorSaveDecision {
	if (!input.syncable) return 'ignore';
	if (input.reviewStaged) return 'hold_review';
	return input.explicit ? 'push' : 'queue_held';
}

/** The pending files a sync with this intent may push, in queue order. */
export function filesForSync(pending: Iterable<string>, intent: SyncIntent, isHeld: (file: string) => boolean): string[] {
	const all = Array.from(pending);
	return intentIncludesHeld(intent) ? all : all.filter(file => !isHeld(file));
}
