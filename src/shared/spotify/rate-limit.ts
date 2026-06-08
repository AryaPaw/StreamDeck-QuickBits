import streamDeck from "@elgato/streamdeck";

const SEARCH_MIN_BACKOFF_MS = 5_000;
const SEARCH_MAX_BACKOFF_MS = 120_000;

const LIBRARY_MIN_BACKOFF_MS = 30_000;
const LIBRARY_MAX_BACKOFF_MS = 3_600_000;
const LIBRARY_GIVE_UP_CONSECUTIVE = 5;
const LIBRARY_GIVE_UP_DURATION_MS = 6 * 60 * 60 * 1000;

type RateLimitBucket = "search" | "library";

class BucketState {
	blockedUntil = 0;
	consecutive429 = 0;
	lastWarnAt = 0;
	giveUpUntil = 0;

	shouldThrottle(): boolean {
		return Date.now() < this.blockedUntil || Date.now() < this.giveUpUntil;
	}

	msUntilReady(): number {
		return Math.max(0, this.blockedUntil - Date.now(), this.giveUpUntil - Date.now());
	}

	isGivenUp(): boolean {
		return Date.now() < this.giveUpUntil;
	}

	record429(
		scope: string,
		response: Response,
		options: { minBackoffMs: number; maxBackoffMs: number; giveUpAfter?: number; giveUpMs?: number }
	): void {
		this.consecutive429 += 1;

		const retryAfterHeader = response.headers.get("Retry-After");
		let backoffMs = options.minBackoffMs * Math.pow(2, this.consecutive429 - 1);
		if (retryAfterHeader) {
			const retryAfterSec = Number.parseInt(retryAfterHeader, 10);
			if (!Number.isNaN(retryAfterSec) && retryAfterSec > 0) {
				backoffMs = Math.max(backoffMs, retryAfterSec * 1000);
			}
		}
		backoffMs = Math.min(backoffMs, options.maxBackoffMs);
		this.blockedUntil = Date.now() + backoffMs;

		const now = Date.now();
		if (now - this.lastWarnAt >= 10_000) {
			this.lastWarnAt = now;
			streamDeck.logger.warn(
				`[Spotify] ${scope}: rate limited (429), retry-after=${retryAfterHeader ?? "none"}, backing off ${Math.ceil(backoffMs / 1000)}s (streak ${this.consecutive429})`
			);
		}

		if (
			options.giveUpAfter !== undefined &&
			options.giveUpMs !== undefined &&
			this.consecutive429 >= options.giveUpAfter &&
			now >= this.giveUpUntil
		) {
			this.giveUpUntil = now + options.giveUpMs;
			streamDeck.logger.error(
				`[Spotify] ${scope}: ${this.consecutive429} consecutive 429s - pausing library checks for ${Math.ceil(options.giveUpMs / 3_600_000)}h. Re-authorize via Spotify Setup or disable other Spotify Stream Deck plugins`
			);
		}
	}

	recordSuccess(): void {
		this.consecutive429 = 0;
		this.blockedUntil = 0;
		this.giveUpUntil = 0;
	}

	clearGiveUp(): void {
		this.giveUpUntil = 0;
	}
}

class SpotifyRateLimit {
	private search = new BucketState();
	private library = new BucketState();
	private libraryHadSuccess = false;

	private bucketForUrl(url: string): RateLimitBucket {
		if (url.includes("/search")) {
			return "search";
		}
		return "library";
	}

	private getBucket(bucket: RateLimitBucket): BucketState {
		return bucket === "search" ? this.search : this.library;
	}

	shouldThrottleSearch(): boolean {
		return this.search.shouldThrottle();
	}

	shouldThrottleLibrary(): boolean {
		return this.library.shouldThrottle();
	}

	shouldGiveUpLibrary(): boolean {
		return this.library.isGivenUp();
	}

	hasLibrarySuccess(): boolean {
		return this.libraryHadSuccess;
	}

	msUntilLibraryReady(): number {
		return this.library.msUntilReady();
	}

	msUntilSearchReady(): number {
		return this.search.msUntilReady();
	}

	record429(url: string, response: Response): void {
		const bucket = this.bucketForUrl(url);
		if (bucket === "search") {
			this.search.record429(bucket, response, {
				minBackoffMs: SEARCH_MIN_BACKOFF_MS,
				maxBackoffMs: SEARCH_MAX_BACKOFF_MS
			});
			return;
		}

		this.library.record429(bucket, response, {
			minBackoffMs: LIBRARY_MIN_BACKOFF_MS,
			maxBackoffMs: LIBRARY_MAX_BACKOFF_MS,
			giveUpAfter: LIBRARY_GIVE_UP_CONSECUTIVE,
			giveUpMs: LIBRARY_GIVE_UP_DURATION_MS
		});
	}

	recordSuccess(url: string): void {
		const bucket = this.bucketForUrl(url);
		this.getBucket(bucket).recordSuccess();
		if (bucket === "library") {
			this.libraryHadSuccess = true;
		}
	}

	clearLibraryGiveUp(): void {
		this.library.clearGiveUp();
	}

	/** @deprecated use shouldThrottleSearch/shouldThrottleLibrary */
	shouldThrottle(): boolean {
		return this.search.shouldThrottle() || this.library.shouldThrottle();
	}

	/** @deprecated use msUntilLibraryReady */
	msUntilReady(): number {
		return Math.max(this.search.msUntilReady(), this.library.msUntilReady());
	}
}

export const spotifyRateLimit = new SpotifyRateLimit();
