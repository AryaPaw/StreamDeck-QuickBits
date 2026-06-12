import streamDeck from "@elgato/streamdeck";
import { getSpotifySettings, saveSpotifySettings } from "./settings";
import { SPOTIFY_WEB_API_LIMITS } from "./limits";
import type { SpotifySettings } from "./types";

const {
	safeRequestsPerWindow,
	noRetryAfterCooldownMs,
	capacityReduceFactor,
	minRequestsPerWindow,
	capacityRecoverEverySuccesses
} = SPOTIFY_WEB_API_LIMITS;

const PERSIST_DEBOUNCE_MS = 500;

class SpotifyRateLimit {
	/** Full Spotify Retry-After window - no outbound Web API until this expires */
	private serverBlockedUntil = 0;
	private consecutive429 = 0;
	private noRetryAfterStreak = 0;
	private lastWarnAt = 0;
	private currentLimit: number = safeRequestsPerWindow;
	private successesSinceReduce = 0;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;

	hydrateFromSettings(settings: SpotifySettings): void {
		if (settings.apiBlockedUntil && settings.apiBlockedUntil > Date.now()) {
			this.serverBlockedUntil = settings.apiBlockedUntil;
			streamDeck.logger.info(
				`[Spotify] Restored API cooldown until ${new Date(this.serverBlockedUntil).toISOString()}`
			);
		}
	}

	shouldThrottle(): boolean {
		return Date.now() < this.serverBlockedUntil;
	}

	msUntilReady(): number {
		return Math.max(0, this.serverBlockedUntil - Date.now());
	}

	getBlockedUntil(): number {
		return this.serverBlockedUntil > Date.now() ? this.serverBlockedUntil : 0;
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

		this.serverBlockedUntil = Math.max(this.serverBlockedUntil, Date.now() + pauseMs);
		this.schedulePersistBlockedUntil();

		const now = Date.now();
		if (now - this.lastWarnAt >= 10_000) {
			this.lastWarnAt = now;
			const waitMin = Math.ceil(pauseMs / 60_000);
			streamDeck.logger.warn(
				`[Spotify] rate limited (429), retry-after=${retryAfterHeader ?? "none"}, no Web API calls for ~${waitMin}m, limit ${this.currentLimit}/30s (streak ${this.consecutive429})`
			);
		}

		if (!usedRetryAfter && pauseMs >= 15 * 60_000) {
			streamDeck.logger.error(
				`[Spotify] extended 429 pause (${Math.ceil(pauseMs / 60_000)}m) - check Spotify Developer Dashboard or disable other plugins using the same Client ID`
			);
		}
	}

	recordSuccess(_url?: string): void {
		this.consecutive429 = 0;
		this.noRetryAfterStreak = 0;
		this.serverBlockedUntil = 0;
		this.schedulePersistBlockedUntil();

		if (this.currentLimit < safeRequestsPerWindow) {
			this.successesSinceReduce += 1;
			if (this.successesSinceReduce >= capacityRecoverEverySuccesses) {
				this.currentLimit = Math.min(safeRequestsPerWindow, this.currentLimit + 1);
				this.successesSinceReduce = 0;
			}
		}
	}

	private schedulePersistBlockedUntil(): void {
		if (this.persistTimer) {
			return;
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.flushPersistBlockedUntil();
		}, PERSIST_DEBOUNCE_MS);
	}

	private async flushPersistBlockedUntil(): Promise<void> {
		const settings = getSpotifySettings();
		const blockedUntil = this.serverBlockedUntil > Date.now() ? this.serverBlockedUntil : undefined;
		if (settings.apiBlockedUntil === blockedUntil) {
			return;
		}
		await saveSpotifySettings({
			...settings,
			apiBlockedUntil: blockedUntil
		});
	}

	private nextNoRetryAfterCooldownMs(): number {
		const idx = Math.min(this.noRetryAfterStreak, noRetryAfterCooldownMs.length - 1);
		this.noRetryAfterStreak += 1;
		return noRetryAfterCooldownMs[idx]!;
	}
}

export const spotifyRateLimit = new SpotifyRateLimit();
