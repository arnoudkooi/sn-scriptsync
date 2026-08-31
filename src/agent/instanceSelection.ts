export interface KnownInstance {
	name: string;
	url?: string | null;
}

export interface LiveInstanceReference {
	name?: string;
	url?: string | null;
}

export type InstanceSelection<T extends KnownInstance> =
	| { kind: 'single'; instance: T }
	| { kind: 'multiple-live'; instances: T[] }
	| { kind: 'multiple-known'; instances: T[] };

function canonicalOrigin(value?: string | null): string {
	if (!value) return '';
	try {
		return new URL(value).origin.toLowerCase();
	} catch {
		return '';
	}
}

/**
 * Prefer a single helper-observed instance without confusing remembered
 * workspace folders with live browser state.
 */
export function selectKnownInstance<T extends KnownInstance>(
	known: T[],
	live: LiveInstanceReference[] = []
): InstanceSelection<T> {
	if (known.length === 1) return { kind: 'single', instance: known[0] };

	const liveOrigins = new Set(live.map((item) => canonicalOrigin(item.url)).filter(Boolean));
	const liveNames = new Set(live.map((item) => item.name?.trim().toLowerCase()).filter((name): name is string => !!name));
	const matches = known.filter((item) => {
		const origin = canonicalOrigin(item.url);
		return (origin && liveOrigins.has(origin)) || liveNames.has(item.name.toLowerCase());
	});

	if (matches.length === 1) return { kind: 'single', instance: matches[0] };
	if (matches.length > 1) return { kind: 'multiple-live', instances: matches };
	return { kind: 'multiple-known', instances: known };
}
