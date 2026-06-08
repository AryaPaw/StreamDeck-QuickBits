import streamDeck from "@elgato/streamdeck";
import { SPOTIFY_WEB_API_LIMITS } from "./limits";

const {
	safeRequestsPerWindow,
	noRetryAfterCooldownMs,
	capacityReduceFactor,
	minRequestsPerWindow,
	capacityRecoverEverySuccesses
} = SPOTIFY_WEB_API_LIMITS;

class SpotifyRateLimit {
	private blockedUntil = 0;
	private consecutive429 = 0;
	private noRetryAfterStreak = 0;
	private lastWarnAt = 0;
	private currentLimit: number = safeRequestsPerWindow;
	private successesSinceReduce = 0;

	shouldThrottle(): boolean {
		return Date.now() < this.blockedUntil;
	}

	msUntilReady(): number {
		return Math.max(0, this.blockedUntil - Date.now());
	}

	getRequestLimit(): number {
		return this.currentLimit;
	}

	record429(_url: string, response: Response): void {
		this.consecutive429 += 1;
		this.currentLimit = Math.max(
			minRequestsPerWindow,
			Math.floor(this.currentLimit * capacityReduceFactor)
		);
		this.successesSinceReduce = 0;

		const retryAfterHeader = response.headers.get("Retry-After");
		let pauseMs: number;
		let usedRetryAfter = false;

		if (retryAfterHeader) {
			const retryAfterSec = Number.parseInt(retryAfterHeader, 10);
			if (!Number.isNaN(retryAfterSec) && retryAfterSec > 0) {
				pauseMs = (retryAfterSec + 1) * 1000;
				usedRetryAfter = true;
				this.noRetryAfterStreak = 0;
			} else {
				pauseMs = this.nextNoRetryAfterCooldownMs();
			}
		} else {
			pauseMs = this.nextNoRetryAfterCooldownMs();
		}

		this.blockedUntil = Math.max(this.blockedUntil, Date.now() + pauseMs);

		const now = Date.now();
		if (now - this.lastWarnAt >= 10_000) {
			this.lastWarnAt = now;
			streamDeck.logger.warn(
				`[Spotify] rate limited (429), retry-after=${retryAfterHeader ?? "none"}, pause ${Math.ceil(pauseMs / 1000)}s, limit ${this.currentLimit}/30s (streak ${this.consecutive429})`
			);
		}

		if (!usedRetryAfter && pauseMs >= 60 * 60_000) {
			streamDeck.logger.error(
				`[Spotify] extended 429 pause (${Math.ceil(pauseMs / 60_000)}m) - check Spotify Developer Dashboard or disable other plugins using the same Client ID`
			);
		}
	}

	recordSuccess(_url?: string): void {
		this.consecutive429 = 0;
		this.noRetryAfterStreak = 0;
		this.blockedUntil = 0;

		if (this.currentLimit < safeRequestsPerWindow) {
			this.successesSinceReduce += 1;
			if (this.successesSinceReduce >= capacityRecoverEverySuccesses) {
				this.currentLimit = Math.min(safeRequestsPerWindow, this.currentLimit + 1);
				this.successesSinceReduce = 0;
			}
		}
	}

	private nextNoRetryAfterCooldownMs(): number {
		const idx = Math.min(this.noRetryAfterStreak, noRetryAfterCooldownMs.length - 1);
		this.noRetryAfterStreak += 1;
		return noRetryAfterCooldownMs[idx]!;
	}
}

export const spotifyRateLimit = new SpotifyRateLimit();
