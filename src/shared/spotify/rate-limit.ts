import streamDeck from "@elgato/streamdeck";

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

class SpotifyRateLimit {
	private blockedUntil = 0;
	private consecutive429 = 0;
	private lastWarnAt = 0;

	shouldThrottle(): boolean {
		return Date.now() < this.blockedUntil;
	}

	msUntilReady(): number {
		return Math.max(0, this.blockedUntil - Date.now());
	}

	record429(scope: string, response: Response): void {
		this.consecutive429 += 1;

		const retryAfterHeader = response.headers.get("Retry-After");
		let backoffMs = MIN_BACKOFF_MS * Math.pow(2, this.consecutive429 - 1);
		if (retryAfterHeader) {
			const retryAfterSec = Number.parseInt(retryAfterHeader, 10);
			if (!Number.isNaN(retryAfterSec) && retryAfterSec > 0) {
				backoffMs = Math.max(backoffMs, retryAfterSec * 1000);
			}
		}
		backoffMs = Math.min(backoffMs, MAX_BACKOFF_MS);
		this.blockedUntil = Date.now() + backoffMs;

		const now = Date.now();
		if (now - this.lastWarnAt >= 10_000) {
			this.lastWarnAt = now;
			streamDeck.logger.warn(
				`[Spotify] ${scope}: rate limited (429), backing off ${Math.ceil(backoffMs / 1000)}s`
			);
		}
	}

	recordSuccess(): void {
		this.consecutive429 = 0;
		this.blockedUntil = 0;
	}
}

export const spotifyRateLimit = new SpotifyRateLimit();
