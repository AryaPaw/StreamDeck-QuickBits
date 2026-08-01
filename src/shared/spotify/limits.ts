/** Client-side Spotify Web API limits (engineering defaults, not official Spotify numbers) */
export const SPOTIFY_WEB_API_LIMITS = {
	windowMs: 30_000,
	safeRequestsPerWindow: 60,
	hardCapRequestsPerWindow: 90,
	minRequestsPerWindow: 15,
	noRetryAfterCooldownMs: [5 * 60_000, 10 * 60_000, 15 * 60_000] as const,
	capacityReduceFactor: 0.5,
	capacityRecoverEverySuccesses: 5,
	/**
	 * Soft daily budget for background like-sync (track-changed / appear / retry).
	 * Manual Like toggle always bypasses this. Not an official Spotify limit.
	 * ~2-4 API calls per track change; 1000 ≈ a full day of listening with headroom.
	 */
	dailyBackgroundLimit: 1000,
	dailyBackgroundWarnAt: 700
} as const;
