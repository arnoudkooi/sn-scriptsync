export interface ReviewExecutionFailure {
	code: string;
	message: string;
	details: Record<string, any>;
}

/** Normalize a helper-side failure that happened after the user approved it. */
export function reviewExecutionFailure(response: any): ReviewExecutionFailure {
	const remoteError = response?.error;
	const message = typeof remoteError === 'string'
		? remoteError
		: remoteError?.message || remoteError?.detail || response?.detail || 'Approved command failed during execution';
	return {
		// A real Reject decision is settled before execution is authorized. An
		// E_USER_REJECTED arriving here is therefore a legacy/mislabelled
		// execution failure, not a second human decision.
		code: response?.code && response.code !== 'E_USER_REJECTED' ? response.code : 'E_COMMAND_FAILED',
		message,
		details: {
			...(response?.details && typeof response.details === 'object' ? response.details : {}),
			status: response?.status,
			detail: response?.detail ?? remoteError?.detail ?? null,
			response: response?.data ?? null,
		},
	};
}
