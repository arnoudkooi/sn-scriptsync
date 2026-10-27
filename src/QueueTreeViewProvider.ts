import * as vscode from 'vscode';
import * as path from 'path';
import { SyncFileState } from './syncTracker';

/** What Pending Saves shows for a file that is not simply waiting. */
export interface QueueFileStatus {
    state: SyncFileState | 'held' | 'changed';
    /** Why this file is waiting, failed or unconfirmed. */
    detail?: string;
}

export class QueueTreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private pendingFiles: Set<string> = new Set();
    // Files that are syncing, failed or unconfirmed (see src/syncTracker.ts).
    // Anything not in here is plainly pending.
    private fileStatus: Map<string, QueueFileStatus> = new Map();
    private currentDeadline: number = 0;
    private view: vscode.TreeView<vscode.TreeItem>;
    private countdownInterval: NodeJS.Timeout | undefined;
    private syncNowCallback: (() => void) | undefined;
    private _isPaused: boolean = false;
    private pausedTimeRemaining: number = 0;
    private isMonitorOnly: boolean = false;

    constructor() { }

    get isPaused(): boolean {
        return this._isPaused;
    }

    private totalCount(): number {
        return this.pendingFiles.size;
    }

    setView(view: vscode.TreeView<vscode.TreeItem>) {
        this.view = view;
    }

    setSyncNowCallback(callback: () => void) {
        this.syncNowCallback = callback;
    }

    syncNow() {
        if (this.syncNowCallback && this.totalCount() > 0) {
            this._isPaused = false;
            this.syncNowCallback();
        }
    }

    togglePause(): boolean {
        if (this.pendingFiles.size === 0) {
            return this._isPaused;
        }

        // In monitor-only mode there is no countdown to pause/resume.
        if (this.isMonitorOnly) {
            return this._isPaused;
        }

        this._isPaused = !this._isPaused;
        
        if (this._isPaused) {
            // Store remaining time and stop countdown
            this.pausedTimeRemaining = Math.max(0, this.currentDeadline - Date.now());
            this.stopCountdown();
        } else {
            // Resume: set new deadline based on remaining time
            this.currentDeadline = Date.now() + this.pausedTimeRemaining;
            this.startCountdown();
        }
        
        this.refresh();
        return this._isPaused;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
        this.updateBadge();
    }

    updateQueue(files: Set<string>, delayMs: number, preserveCountdown = false) {
        this.pendingFiles = new Set(files);
        for (const filePath of Array.from(this.fileStatus.keys())) {
            if (!this.pendingFiles.has(filePath)) this.fileStatus.delete(filePath);
        }

        // Adding a held file must not hide another file's active countdown.
        if (preserveCountdown) {
            this.refresh();
            return;
        }

        // delayMs <= 0 means "monitor only": keep a queue/badge, but don't start a countdown.
        this.isMonitorOnly = delayMs <= 0;

        if (!this._isPaused) {
            if (this.isMonitorOnly) {
                this.currentDeadline = 0;
                this.pausedTimeRemaining = 0;
                this.stopCountdown();
            } else {
                this.currentDeadline = Date.now() + delayMs;
                this.startCountdown();
            }
        } else {
            // If paused, just update the remaining time for when we resume
            this.pausedTimeRemaining = delayMs;
        }
        this.refresh();
    }

    clearQueue() {
        this.pendingFiles.clear();
        this.fileStatus.clear();
        this._isPaused = false;
        this.pausedTimeRemaining = 0;
        this.isMonitorOnly = false;
        this.stopCountdown();
        this.refresh();
    }

    addToQueue(filePath: string) {
        this.pendingFiles.add(filePath);
        this.refresh();
    }

    removeFromQueue(filePath: string) {
        this.pendingFiles.delete(filePath);
        this.fileStatus.delete(filePath);
        this.refresh();
    }

    /** 'pending' clears an earlier status; other states explain why it remains. */
    setFileStatus(filePath: string, state: QueueFileStatus['state'], detail?: string) {
        if (state === 'pending') this.fileStatus.delete(filePath);
        else this.fileStatus.set(filePath, { state, detail });
        this.refresh();
    }

    setPendingStatus(filePath: string, heldReason?: string, newerChanges = false) {
        const previous = this.fileStatus.get(filePath);
        // A watcher notification must not hide an outstanding save or its error.
        if (!newerChanges && ['syncing', 'failed', 'unconfirmed'].includes(previous?.state)) return;
        if (heldReason) {
            this.setFileStatus(filePath, 'held', newerChanges
                ? `The previous version was saved. New changes are waiting. ${heldReason}`
                : heldReason);
        } else if (newerChanges || previous?.state === 'changed') {
            this.setFileStatus(filePath, 'changed', 'The previous version was saved. This file has newer changes that have not been confirmed saved.');
        } else {
            this.setFileStatus(filePath, 'pending');
        }
    }

    private startCountdown() {
        this.stopCountdown();
        this.countdownInterval = setInterval(() => {
            if (this.pendingFiles.size > 0) {
                this.refresh();
            } else {
                this.stopCountdown();
            }
        }, 1000);
    }

    private stopCountdown() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = undefined;
        }
    }

    private updateBadge() {
        if (this.view) {
            const count = this.totalCount();
            if (count > 0) {
                let syncing = 0, held = 0, attention = 0, waiting = 0;
                for (const file of this.pendingFiles) {
                    const state = this.fileStatus.get(file)?.state;
                    if (state === 'syncing') syncing++;
                    else if (state === 'held') held++;
                    else if (state === 'failed' || state === 'unconfirmed') attention++;
                    else waiting++;
                }
                if (this.isMonitorOnly) { held += waiting; waiting = 0; }
                const parts: string[] = [];
                if (syncing) parts.push(`${syncing} syncing`);
                if (waiting) parts.push(this._isPaused ? `${waiting} paused` : `${waiting} auto-sync in ${this.remainingSeconds()}s`);
                if (held) parts.push(`${held} waiting for Sync Now`);
                if (attention) parts.push(`${attention} need attention`);
                this.view.description = parts.join(' · ');
                this.view.badge = { tooltip: parts.join('\n'), value: count };
            } else {
                this.view.badge = undefined;
                this.view.description = undefined;
            }
        }
    }

    private remainingSeconds(): number {
        return Math.max(0, Math.ceil((this.currentDeadline - Date.now()) / 1000));
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const fileItems = Array.from(this.pendingFiles).map((filePath) => {
            const fileName = path.basename(filePath);
            const relativePath = vscode.workspace.asRelativePath(filePath);
            
            return new QueueItem(
                fileName,
                relativePath,
                filePath,
                vscode.TreeItemCollapsibleState.None,
                this.fileStatus.get(filePath),
                this._isPaused ? 'Auto-sync paused' : this.isMonitorOnly
                    ? 'Waiting for Sync Now' : `Auto-sync in ${this.remainingSeconds()}s`
            );
        });

        return Promise.resolve(fileItems);
    }

    getFilePath(item: QueueItem): string {
        return item.filePath;
    }
}

export class QueueItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly relativePath: string,
        public readonly filePath: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        status?: QueueFileStatus,
        waitingLabel = 'Waiting for Sync Now'
    ) {
        super(label, collapsibleState);
        this.tooltip = `${this.relativePath}\n${waitingLabel}. Use Sync Now or the check mark to sync this file.`;
        this.description = `${waitingLabel} · ${this.relativePath}`;
        this.iconPath = new vscode.ThemeIcon('cloud-upload');
        this.contextValue = 'queueItem';

        // A save in flight keeps its file here until the helper tab confirms it.
        // Failed and unconfirmed saves stay, held for the user, with the reason.
        if (status?.state === 'syncing') {
            this.iconPath = new vscode.ThemeIcon('sync~spin');
            this.description = `Syncing… ${this.relativePath}`;
            this.tooltip = `${this.relativePath}\nWaiting for the instance to confirm this save.`;
            this.contextValue = 'queueItemSyncing';
        } else if (status?.state === 'failed') {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
            this.description = `Failed: ${status.detail || 'the instance refused the save'}`;
            this.tooltip = `${this.relativePath}\nSync failed: ${status.detail || 'the instance refused the save'}\nFix the cause and sync it again with the check mark.`;
        } else if (status?.state === 'unconfirmed') {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
            this.description = `Unconfirmed: ${status.detail || 'no answer from the helper tab'}`;
            this.tooltip = `${this.relativePath}\nNot confirmed: ${status.detail || 'no answer from the helper tab'}\nCheck the helper tab log, then sync it again with the check mark.`;
        } else if (status?.state === 'held') {
            this.iconPath = new vscode.ThemeIcon('hand');
            this.description = `Waiting for Sync Now · ${this.relativePath}`;
            this.tooltip = `${this.relativePath}\n${status.detail || 'This file needs your approval to sync.'}\nReview the changes, then use Sync Now or the check mark. Auto-sync will not send this file.`;
        } else if (status?.state === 'changed') {
            this.description = `New changes pending · ${this.relativePath}`;
            this.tooltip = `${this.relativePath}\n${status.detail}\n${waitingLabel}. Use Sync Now or the check mark to sync this file.`;
        }

        // Clicking a pending file should open/activate it in the editor.
        this.resourceUri = vscode.Uri.file(this.filePath);
        this.command = {
            command: 'extension.openQueuedFile',
            title: 'Open Pending File',
            arguments: [this]
        };
    }
}
