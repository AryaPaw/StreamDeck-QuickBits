/** Client-side Spotify Web API limits (engineering defaults, not official Spotify numbers) */
export const SPOTIFY_WEB_API_LIMITS = {
	windowMs: 30_000,
	safeRequestsPerWindow: 60,
	hardCapRequestsPerWindow: 90,
	minRequestsPerWindow: 15,
	noRetryAfterCooldownMs: [5 * 60_000, 15 * 60_000, 60 * 60_000] as const,
	capacityReduceFactor: 0.5,
	capacityRecoverEverySuccesses: 5
} as const;
