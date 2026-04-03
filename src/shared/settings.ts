export type SetVolumeSettings = {
	percent?: number;
};

export type ToggleDndSettings = Record<string, never>;

const DEFAULT_PERCENT = 30;

export function normalizePercent(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.min(100, Math.round(value)));
	}
	if (typeof value === "string") {
		const parsed = parseInt(value, 10);
		if (Number.isFinite(parsed)) {
			return Math.max(0, Math.min(100, parsed));
		}
	}
	return DEFAULT_PERCENT;
}
