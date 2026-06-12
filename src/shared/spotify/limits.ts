/** Client-side Spotify Web API limits (engineering defaults, not official Spotify numbers) */
export const SPOTIFY_WEB_API_LIMITS = {
	windowMs: 30_000,
	safeRequestsPerWindow: 60,
	hardCapRequestsPerWindow: 90,
	minRequestsPerWindow: 15,
	noRetryAfterCooldownMs: [5 * 60_000, 10 * 60_000, 15 * 60_000] as const,
	capacityReduceFactor: 0.5,
	capacityRecoverEverySuccesses: 5,
	/** Plugin-side daily cap (not Spotify official); blocks background API after this */
	dailyRequestLimit: 300,
	dailyRequestWarnAt: 150
} as const;
