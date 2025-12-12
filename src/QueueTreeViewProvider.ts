import * as vscode from 'vscode';
import * as path from 'path';

export class QueueTreeViewProvider implements vscode.TreeDataProvider<QueueItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<QueueItem | undefined | null | void> = new vscode.EventEmitter<QueueItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<QueueItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private pendingFiles: Set<string> = new Set();
    private currentDeadline: number = 0;
    private view: vscode.TreeView<QueueItem>;
    private countdownInterval: NodeJS.Timeout | undefined;
    private syncNowCallback: (() => void) | undefined;
    private _isPaused: boolean = false;
    private pausedTimeRemaining: number = 0;
    private isMonitorOnly: boolean = false;

    constructor() { }

    get isPaused(): boolean {
        return this._isPaused;
    }

    setView(view: vscode.TreeView<QueueItem>) {
        this.view = view;
    }

    setSyncNowCallback(callback: () => void) {
        this.syncNowCallback = callback;
    }

    syncNow() {
        if (this.syncNowCallback && this.pendingFiles.size > 0) {
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

    updateQueue(files: Set<string>, delayMs: number) {
        this.pendingFiles = new Set(files);

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
        this.refresh();
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
            const count = this.pendingFiles.size;
            if (count > 0) {
                if (this._isPaused) {
                    const remainingSeconds = Math.max(0, Math.ceil(this.pausedTimeRemaining / 1000));
                    this.view.badge = {
                        tooltip: `${count} pending save${count !== 1 ? 's' : ''} - PAUSED (${remainingSeconds}s remaining)`,
                        value: count
                    };
                    this.view.description = `⏸ Paused (${remainingSeconds}s)`;
                } else if (this.isMonitorOnly) {
                    this.view.badge = {
                        tooltip: `${count} pending save${count !== 1 ? 's' : ''} - monitoring (manual sync)`,
                        value: count
                    };
                    this.view.description = `Monitoring`;
                } else {
                    const remainingSeconds = Math.max(0, Math.ceil((this.currentDeadline - Date.now()) / 1000));
                    this.view.badge = {
                        tooltip: `${count} pending save${count !== 1 ? 's' : ''} - syncing in ${remainingSeconds}s`,
                        value: count
                    };
                    this.view.description = `Syncing in ${remainingSeconds}s`;
                }
            } else {
                this.view.badge = undefined;
                this.view.description = undefined;
            }
        }
    }

    getTreeItem(element: QueueItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: QueueItem): Thenable<QueueItem[]> {
        if (element) {
            return Promise.resolve([]);
        }
        
        const items = Array.from(this.pendingFiles).map((filePath) => {
            const fileName = path.basename(filePath);
            const relativePath = vscode.workspace.asRelativePath(filePath);
            
            return new QueueItem(
                fileName,
                relativePath,
                filePath,
                vscode.TreeItemCollapsibleState.None
            );
        });

        return Promise.resolve(items);
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
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.tooltip = this.relativePath;
        this.description = this.relativePath;
        this.iconPath = new vscode.ThemeIcon('cloud-upload');
        this.contextValue = 'queueItem';

        // Clicking a pending file should open/activate it in the editor.
        this.resourceUri = vscode.Uri.file(this.filePath);
        this.command = {
            command: 'extension.openQueuedFile',
            title: 'Open Pending File',
            arguments: [this]
        };
    }
}
