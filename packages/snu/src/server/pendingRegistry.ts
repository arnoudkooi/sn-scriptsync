export interface PendingEntry<T = any> {
  id: string;
  command: string;
  instanceFolder?: string;
  timeoutMs: number;
  timer: NodeJS.Timeout;
  resolve: (value: T) => void;
  reject: (err: any) => void;
}

export class PendingRegistry {
  private entries = new Map<string, PendingEntry>();

  register<T = any>(opts: {
    id: string;
    command: string;
    instanceFolder?: string;
    timeoutMs?: number;
  }): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.entries.delete(opts.id);
        const err = new Error(`Command '${opts.command}' timed out after ${timeoutMs / 1000}s waiting for browser response`);
        (err as any).code = 'E_TIMEOUT';
        reject(err);
      }, timeoutMs);

      this.entries.set(opts.id, {
        id: opts.id,
        command: opts.command,
        instanceFolder: opts.instanceFolder,
        timeoutMs,
        timer,
        resolve,
        reject,
      });
    });
  }

  resolve(id: string, value: any): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    entry.resolve(value);
    return true;
  }

  reject(id: string, code: string, message: string, details?: any): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    const err = new Error(message);
    (err as any).code = code;
    (err as any).details = details;
    entry.reject(err);
    return true;
  }

  cancel(id: string, reason = 'CANCELLED'): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    const err = new Error(`Request was cancelled: ${reason}`);
    (err as any).code = 'E_COMMAND_FAILED';
    entry.reject(err);
    return true;
  }

  rejectAll(code: string, message: string): void {
    for (const [id, entry] of this.entries.entries()) {
      clearTimeout(entry.timer);
      const err = new Error(message);
      (err as any).code = code;
      entry.reject(err);
    }
    this.entries.clear();
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  size(): number {
    return this.entries.size;
  }
}

export const defaultPendingRegistry = new PendingRegistry();
