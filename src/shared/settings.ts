export type SetVolumeSettings = {
	percent?: number;
};

export type ToggleDndSettings = Record<string, never>;

export type SkydimoLightingMode = "sync" | "static" | "off";

/** Persisted Stream Deck action state: last successful lighting mode chosen via trigger apps */
export type SkydimoLightingToggleSettings = {
	screenSyncActive?: boolean;
	/** Tri-state when set; legacy keys use only screenSyncActive (sync vs static). */
	lightingMode?: SkydimoLightingMode;
};

export function normalizeSkydimoLightingMode(settings: SkydimoLightingToggleSettings): SkydimoLightingMode {
	const m = settings.lightingMode;
	if (m === "sync" || m === "static" || m === "off") {
		return m;
	}
	return settings.screenSyncActive === true ? "sync" : "static";
}

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
