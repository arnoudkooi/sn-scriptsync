import { AgentResponse } from '../types.js';

interface Review {
  command: string;
  running: boolean;
  response?: AgentResponse;
  waiters: Set<() => void>;
  timer: NodeJS.Timeout;
}

// Per dispatcher: clients share outcomes on one bridge, never across bridges.
export class ReviewRegistry {
  private entries = new Map<string, Review>();

  register(reviewId: string, command: string): void {
    const timer = setTimeout(() => this.remove(reviewId), 2 * 60 * 60_000);
    timer.unref();
    this.entries.set(reviewId, { command, running: false, waiters: new Set(), timer });
  }

  private remove(reviewId: string): void {
    const entry = this.entries.get(reviewId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(reviewId);
    for (const wake of entry.waiters) wake();
  }

  markRunning(reviewId: string): void {
    const entry = this.entries.get(reviewId);
    if (entry && !entry.response) entry.running = true;
  }

  settle(reviewId: string, response: AgentResponse): void {
    const entry = this.entries.get(reviewId);
    if (!entry || entry.response) return;
    clearTimeout(entry.timer);
    entry.running = false;
    entry.response = response;
    entry.timer = setTimeout(() => this.remove(reviewId), 10 * 60_000);
    entry.timer.unref();
    for (const wake of entry.waiters) wake();
  }

  get(reviewId: string): Review | undefined { return this.entries.get(reviewId); }

  async wait(reviewId: string, timeoutMs: number): Promise<Review | undefined> {
    const entry = this.entries.get(reviewId);
    if (!entry || entry.response || timeoutMs === 0) return entry;
    await new Promise<void>((resolve) => {
      const wake = () => { clearTimeout(timer); entry.waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, timeoutMs);
      entry.waiters.add(wake);
    });
    return this.entries.get(reviewId);
  }
}
