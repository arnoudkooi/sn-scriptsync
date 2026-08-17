// Tracks two-phase human reviews that were answered to the agent with
// E_REVIEW_PENDING, so a later `get_review_result` call can collect the
// outcome. The dispatcher registers the review before returning the pending
// response and settles it when the helper tab replies (approve / reject /
// timeout); get_review_result long-polls against this registry.

import { AgentResponse } from './types';

interface PendingReview {
	reviewId: string;
	requestId: string;
	command: string;
	createdAt: number;
	settled: boolean;
	response?: AgentResponse; // final response once settled
	waiters: Array<() => void>; // long-poll wakeups
}

// Settled results stay collectable for a while after the 5-minute review
// window, so a slow agent can still pick them up.
const RETENTION_AFTER_EXPIRY_MS = 10 * 60_000;

const reviews = new Map<string, PendingReview>();

export function registerReview(reviewId: string, requestId: string, command: string, reviewTimeoutMs: number): void {
	reviews.set(reviewId, {
		reviewId,
		requestId,
		command,
		createdAt: Date.now(),
		settled: false,
		waiters: [],
	});
	const t = setTimeout(() => { reviews.delete(reviewId); }, reviewTimeoutMs + RETENTION_AFTER_EXPIRY_MS);
	(t as any).unref?.();
}

export function settleReview(reviewId: string, response: AgentResponse): void {
	const r = reviews.get(reviewId);
	if (!r || r.settled) return;
	r.settled = true;
	r.response = response;
	r.waiters.splice(0).forEach((wake) => wake());
}

export function hasReview(reviewId: string): boolean {
	return reviews.has(reviewId);
}

export function getReviewCommand(reviewId: string): string | undefined {
	return reviews.get(reviewId)?.command;
}

/**
 * Wait up to timeoutMs for the review to settle. Returns the final response,
 * or null when the review is still pending after the wait (caller re-polls).
 */
export async function waitForReview(reviewId: string, timeoutMs: number): Promise<AgentResponse | null> {
	const r = reviews.get(reviewId);
	if (!r) return null;
	if (r.settled) return r.response!;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		(timer as any).unref?.();
		r.waiters.push(() => { clearTimeout(timer); resolve(); });
	});
	const again = reviews.get(reviewId);
	return again?.settled ? again.response! : null;
}
