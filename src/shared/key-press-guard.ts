/**
 * Drops rapid repeat key presses per Stream Deck action instance (context id).
 * Matches Skydimo lighting toggle semantics: silent ignore, in-flight lock, optional min interval.
 */
export class KeyPressGuard {
	constructor(private readonly minIntervalMs = 250) {}

	isInFlight(contextId: string): boolean {
		return this.inFlightContextIds.has(contextId);
	}

	canTrigger(contextId: string): boolean {
		const now = Date.now();
		const lastPressAt = this.lastPressByContext.get(contextId) ?? 0;
		return !this.inFlightContextIds.has(contextId) && now - lastPressAt >= this.minIntervalMs;
	}

	async run<T>(contextId: string, fn: () => Promise<T>): Promise<T | undefined> {
		if (!this.canTrigger(contextId)) {
			return undefined;
		}

		const now = Date.now();
		this.inFlightContextIds.add(contextId);
		this.lastPressByContext.set(contextId, now);

		try {
			return await fn();
		} finally {
			this.inFlightContextIds.delete(contextId);
			this.lastPressByContext.set(contextId, Date.now());
		}
	}

	private readonly inFlightContextIds = new Set<string>();
	private readonly lastPressByContext = new Map<string, number>();
}

/** Helper toggle-dnd sleeps ~900ms; use full cycle so presses cannot overlap */
export const DND_TOGGLE_CYCLE_MS = 1000;
