import streamDeck from "@elgato/streamdeck";
import { getSpotifySettings, loadSpotifySettings, saveSpotifySettings } from "./settings";
import { spotifyAPI } from "./api";
import { spotifyApiGateway } from "./api-gateway";
import { spotifyApiMetrics } from "./api-metrics";
import { spotifyRateLimit } from "./rate-limit";
import { spotifyLocalClient } from "./local/client";
import { mapLocalStateToTrack, stabilizeTrackIdentity } from "./local/map";
import type { SpotifyLocalState } from "./local/types";
import type {
	SpotifyLikeApiStatus,
	SpotifyPlaybackState,
	SpotifySettings,
	SpotifyTrack,
	StateListener
} from "./types";

const TRANSITION_HOLD_MS = 2_000;
const AUTO_ADVANCE_PLAYING_MS = 2_000;
const PAUSED_CLEAR_MS = 2_000;
const TRANSPORT_PLAYING_GRACE_MS = 500;
const LIKE_SKIP_AFTER_TOGGLE_MS = 5_000;
const LIKE_CACHE_HIT_GRACE_MS = 15_000;
const MAX_LIKE_RETRIES = 1;
const LIKE_RECOVERY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 45_000, 60_000] as const;
/** Geo/VPN blocks clear slowly - do not hammer API or force token refresh */
const LIKE_GEO_RECOVERY_DELAYS_MS = [60_000, 120_000, 180_000, 300_000] as const;
const RETRY_SCHEDULE_REASONS = new Set([
	"track-changed",
	"like-button-appear",
	"playing-changed",
	"recovery",
	"retry"
]);
const BYPASS_DAILY_BUDGET_REASONS = new Set([
	"track-changed",
	"playing-changed",
	"like-button-appear",
	"recovery"
]);
const MAX_LIKED_CACHE_ENTRIES = 200;
const PLAYING_OPTIMISTIC_HOLD_MS = 2_000;

type LikedCacheEntry = { isLiked: boolean; at: number };

class SpotifyState {
	private listeners: Set<StateListener> = new Set();
	private unsubscribeLocal: (() => void) | null = null;
	private currentState: SpotifyPlaybackState = {
		track: null,
		playbackState: "unknown",
		isLiked: false,
		likeApiStatus: "ok",
		likeKnown: false
	};
	private lastTrackId: string | null = null;
	private lastTrackAt = 0;
	private lastTrackChangedAt = 0;
	/** True only when switching from one track to another - not cold start null->track */
	private lastTrackChangeWasSwitch = false;
	private lastWasPlaying = false;
	private lastPlayingTrueAt = 0;
	private pausedSince = 0;
	private autoAdvancePlayingUntil = 0;
	private likedCheckInFlight = false;
	private likedResultCache = new Map<string, LikedCacheEntry>();
	private likedByUriCache = new Map<string, LikedCacheEntry>();
	private likeSyncRefs = 0;
	private likeRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private likeRetryCount = 0;
	private likeRetryTrackId: string | null = null;
	private likeRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
	private likeRecoveryAttempt = 0;
	private likeCacheHydrated = false;
	private likeSkipUntil = 0;
	private playingOptimisticUntil = 0;
	private localStateChain: Promise<void> = Promise.resolve();

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		listener(this.currentState);

		if (this.listeners.size === 1) {
			this.unsubscribeLocal = spotifyLocalClient.subscribe((local) => {
				this.localStateChain = this.localStateChain
					.then(() => this.processLocalState(local))
					.catch(() => {});
			});
		}

		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				this.unsubscribeLocal?.();
				this.unsubscribeLocal = null;
			}
		};
	}

	registerLikeSync(): Promise<void> {
		this.likeSyncRefs += 1;
		if (this.likeSyncRefs === 1) {
			return this.bootstrapLikeSync();
		}
		return Promise.resolve();
	}

	unregisterLikeSync(): void {
		this.likeSyncRefs = Math.max(0, this.likeSyncRefs - 1);
		if (this.likeSyncRefs === 0) {
			this.stopLikeTimers();
			this.likeRecoveryAttempt = 0;
		}
	}

	private async bootstrapLikeSync(): Promise<void> {
		const settings = await loadSpotifySettings();
		spotifyRateLimit.hydrateFromSettings(settings);
		this.hydrateLikedCache(settings);
		spotifyAPI.hydrateUriCache(settings);
		this.refreshLikeApiStatus();

		const track = this.currentState.track;
		if (!track) {
			return;
		}

		this.applyCachedLikeIfAny(track);
		void this.enrichIsLiked(track, "like-button-appear");
	}

	private hydrateLikedCache(settings: SpotifySettings): void {
		if (this.likeCacheHydrated) {
			return;
		}
		this.likeCacheHydrated = true;
		const cached = settings.likedCache;
		if (!cached) {
			return;
		}
		for (const [trackId, entry] of Object.entries(cached)) {
			this.likedResultCache.set(trackId, entry);
		}
	}

	private persistLikedCache(): void {
		const settings = getSpotifySettings();
		const entries = [...this.likedResultCache.entries()]
			.sort((a, b) => b[1].at - a[1].at)
			.slice(0, MAX_LIKED_CACHE_ENTRIES)
			.map(([trackId, entry]) => [trackId, entry] as const);
		void saveSpotifySettings({
			...settings,
			likedCache: Object.fromEntries(entries)
		});
	}

	private rememberLiked(trackId: string, isLiked: boolean): void {
		const entry = { isLiked, at: Date.now() };
		this.likedResultCache.set(trackId, entry);
		const uri = spotifyAPI.getCachedUri(trackId);
		if (uri) {
			this.likedByUriCache.set(uri, entry);
		}
		this.persistLikedCache();
	}

	private clearLikedCacheForTrack(trackId: string): void {
		const uri = spotifyAPI.getCachedUri(trackId);
		this.likedResultCache.delete(trackId);
		if (uri) {
			this.likedByUriCache.delete(uri);
		}
		this.persistLikedCache();
	}

	private emit(state: SpotifyPlaybackState): void {
		for (const listener of this.listeners) {
			listener(state);
		}
	}

	private isLikeStatusDegraded(): boolean {
		return (
			this.currentState.likeApiStatus === "unavailable" ||
			this.currentState.likeApiStatus === "rate_limited" ||
			this.currentState.likeApiStatus === "geo_blocked"
		);
	}

	private needsLikeRecovery(): boolean {
		if (this.likeSyncRefs === 0) {
			return false;
		}
		// Soft-cached heart during geo still needs background re-verify
		if (this.currentState.likeApiStatus === "geo_blocked") {
			return true;
		}
		return !this.currentState.likeKnown && this.isLikeStatusDegraded();
	}

	private getCachedLike(trackId: string): LikedCacheEntry | null {
		return this.likedResultCache.get(trackId) ?? null;
	}

	private getCachedLikeForTrack(track: SpotifyTrack): LikedCacheEntry | null {
		const uri = spotifyAPI.getCachedUri(track.id);
		if (uri) {
			const byUri = this.likedByUriCache.get(uri);
			if (byUri) {
				return byUri;
			}
		}
		// Do not trust trackId-only liked cache without a matching URI entry -
		// it can stay green after liking a wrong duplicate URI
		return null;
	}

	private applyCachedLikeIfAny(track: SpotifyTrack): boolean {
		const cached = this.getCachedLikeForTrack(track);
		if (!cached) {
			return false;
		}
		this.currentState = {
			...this.currentState,
			isLiked: cached.isLiked,
			likeKnown: true
		};
		this.emit(this.currentState);
		return true;
	}

	private applyPlayingGrace(track: SpotifyTrack, local: SpotifyLocalState): SpotifyTrack {
		const playbackState = local.player.state;

		if (playbackState === "playing") {
			this.lastWasPlaying = true;
			this.lastPlayingTrueAt = Date.now();
			this.pausedSince = 0;
			return { ...track, isPlaying: true };
		}

		if (Date.now() < this.autoAdvancePlayingUntil) {
			return { ...track, isPlaying: true };
		}

		if (
			(playbackState === "paused" || playbackState === "unknown") &&
			spotifyLocalClient.wasRecentSkipTransport(TRANSPORT_PLAYING_GRACE_MS)
		) {
			return { ...track, isPlaying: true };
		}

		if (playbackState === "stopped") {
			this.lastWasPlaying = false;
			this.pausedSince = 0;
			return { ...track, isPlaying: false };
		}

		if (playbackState === "unknown") {
			if (this.wasRecentlyPlaying() || Date.now() < this.autoAdvancePlayingUntil) {
				return { ...track, isPlaying: true };
			}
			this.pausedSince = 0;
			return { ...track, isPlaying: false };
		}

		if (playbackState === "paused") {
			if (this.pausedSince === 0) {
				this.pausedSince = Date.now();
			}
			if (Date.now() - this.pausedSince >= PAUSED_CLEAR_MS) {
				this.lastWasPlaying = false;
			}
			return { ...track, isPlaying: false };
		}

		this.pausedSince = 0;
		return { ...track, isPlaying: false };
	}

	private wasRecentlyPlaying(): boolean {
		return (
			this.lastWasPlaying ||
			Date.now() - this.lastPlayingTrueAt < 10_000 ||
			Date.now() < this.autoAdvancePlayingUntil
		);
	}

	private async processLocalState(local: SpotifyLocalState): Promise<void> {
		const playbackState = local.player.state;
		let track = mapLocalStateToTrack(local);
		let isLiked = this.currentState.isLiked;
		let likeKnown = this.currentState.likeKnown;
		let likeApiStatus = this.currentState.likeApiStatus;
		let trackChanged = false;

		if (!track) {
			if (this.currentState.track && Date.now() - this.lastTrackAt < TRANSITION_HOLD_MS) {
				track = this.applyPlayingGrace(this.currentState.track, local);
			} else {
				this.lastTrackId = null;
				isLiked = false;
				likeKnown = false;
			}
		} else {
			track = this.applyPlayingGrace(track, local);
			track = stabilizeTrackIdentity(track, this.currentState.track);
			if (Date.now() < this.playingOptimisticUntil && this.currentState.track) {
				if (track.isPlaying === this.currentState.track.isPlaying) {
					this.playingOptimisticUntil = 0;
				} else {
					track = { ...track, isPlaying: this.currentState.track.isPlaying };
				}
			}
			this.lastTrackAt = Date.now();

			if (track.id !== this.lastTrackId) {
				const wasPlaying = this.wasRecentlyPlaying();
				const previousTrackId = this.lastTrackId;
				this.lastTrackId = track.id;
				this.lastTrackChangedAt = Date.now();
				// Cold start (null -> track) is not a skip - do not force cache-grace API burn
				this.lastTrackChangeWasSwitch = previousTrackId !== null;
				trackChanged = true;
				this.pausedSince = 0;
				this.likeRetryCount = 0;
				this.likeRetryTrackId = track.id;
				this.likeRecoveryAttempt = 0;
				if (this.likeRetryTimer) {
					clearTimeout(this.likeRetryTimer);
					this.likeRetryTimer = null;
				}
				if (this.likeRecoveryTimer) {
					clearTimeout(this.likeRecoveryTimer);
					this.likeRecoveryTimer = null;
				}

				const cached = this.getCachedLikeForTrack(track);
				if (cached) {
					isLiked = cached.isLiked;
					likeKnown = true;
				} else {
					isLiked = false;
					likeKnown = false;
				}

				if (wasPlaying) {
					this.lastWasPlaying = true;
					this.lastPlayingTrueAt = Date.now();
					this.autoAdvancePlayingUntil = Date.now() + AUTO_ADVANCE_PLAYING_MS;
					track = { ...track, isPlaying: true };
				}

				likeApiStatus = this.probeLikeApiStatus(track);
			}
		}

		const playbackStateChanged = this.currentState.playbackState !== playbackState;
		const playingChanged = this.currentState.track?.isPlaying !== track?.isPlaying;
		const likedChanged =
			this.currentState.isLiked !== isLiked ||
			this.currentState.likeKnown !== likeKnown ||
			this.currentState.likeApiStatus !== likeApiStatus;
		const artChanged =
			this.currentState.track?.albumArtBase64 !== track?.albumArtBase64 ||
			this.currentState.track?.albumArtPath !== track?.albumArtPath;
		const metaChanged =
			track !== null &&
			this.currentState.track !== null &&
			(track.name !== this.currentState.track.name ||
				track.artist !== this.currentState.track.artist ||
				track.album !== this.currentState.track.album);
		const hadTrack = this.currentState.track !== null;

		if (
			trackChanged ||
			playbackStateChanged ||
			playingChanged ||
			likedChanged ||
			artChanged ||
			metaChanged ||
			(track === null && hadTrack)
		) {
			this.currentState = { ...this.currentState, track, playbackState, isLiked, likeKnown, likeApiStatus };
			this.emit(this.currentState);
		}

		if (trackChanged && track) {
			void spotifyLocalClient.refreshArtwork();
			if (this.likeSyncRefs > 0) {
				void this.enrichIsLiked(track, "track-changed");
			}
		} else if (playingChanged && track && this.needsLikeRecovery()) {
			void this.enrichIsLiked(track, "playing-changed");
		}
	}

	private stopLikeTimers(): void {
		if (this.likeRetryTimer) {
			clearTimeout(this.likeRetryTimer);
			this.likeRetryTimer = null;
		}
		if (this.likeRecoveryTimer) {
			clearTimeout(this.likeRecoveryTimer);
			this.likeRecoveryTimer = null;
		}
	}

	private scheduleDegradedRecovery(track: SpotifyTrack): void {
		if (!this.needsLikeRecovery() || this.likeRecoveryTimer || this.likeRetryTimer) {
			return;
		}

		const delays =
			this.currentState.likeApiStatus === "geo_blocked"
				? LIKE_GEO_RECOVERY_DELAYS_MS
				: LIKE_RECOVERY_DELAYS_MS;
		const delayIndex = Math.min(this.likeRecoveryAttempt, delays.length - 1);
		const delay = delays[delayIndex]!;
		this.likeRecoveryAttempt += 1;

		streamDeck.logger.info(
			`[Spotify] Like recovery ${this.likeRecoveryAttempt} for "${track.name}" in ${Math.ceil(delay / 1000)}s (status=${this.currentState.likeApiStatus})`
		);

		this.likeRecoveryTimer = setTimeout(() => {
			this.likeRecoveryTimer = null;
			const current = this.currentState.track;
			if (!current || this.likeSyncRefs === 0 || !this.needsLikeRecovery()) {
				return;
			}
			void this.enrichIsLiked(current, "recovery");
		}, delay);
	}

	private clearDegradedRecovery(): void {
		this.likeRecoveryAttempt = 0;
		if (this.likeRecoveryTimer) {
			clearTimeout(this.likeRecoveryTimer);
			this.likeRecoveryTimer = null;
		}
	}

	private resetLikeRetryState(trackId: string): void {
		if (this.likeRetryTrackId !== trackId) {
			this.likeRetryTrackId = trackId;
			this.likeRetryCount = 0;
		}
	}

	private scheduleLikeRetry(track: SpotifyTrack, reason: string): void {
		if (!RETRY_SCHEDULE_REASONS.has(reason) || this.likeSyncRefs === 0 || this.likeRetryTimer) {
			return;
		}
		this.resetLikeRetryState(track.id);
		if (this.likeRetryCount >= MAX_LIKE_RETRIES) {
			streamDeck.logger.info(
				`[Spotify] Like check stopped retrying (${reason}) for "${track.name}" - will retry on track change`
			);
			return;
		}
		this.likeRetryCount += 1;

		const readyMs = spotifyRateLimit.msUntilReady();
		const jitterMs = readyMs > 0 ? 30_000 + Math.floor(Math.random() * 90_000) : 0;
		const delay = Math.max(2_000, readyMs + jitterMs + 500);

		streamDeck.logger.info(
			`[Spotify] Like check retry ${this.likeRetryCount}/${MAX_LIKE_RETRIES} (${reason}) for "${track.name}" in ${Math.ceil(delay / 1000)}s`
		);

		this.likeRetryTimer = setTimeout(() => {
			this.likeRetryTimer = null;
			const current = this.currentState.track;
			if (!current || current.id !== track.id || this.likeSyncRefs === 0) {
				return;
			}
			void this.enrichIsLiked(current, "retry");
		}, delay);
	}

	private probeLikeApiStatus(track: SpotifyTrack | null): SpotifyLikeApiStatus {
		const settings = getSpotifySettings();
		if (!settings.refreshToken) {
			return "no_auth";
		}
		if (track && this.getCachedLikeForTrack(track)) {
			return "ok";
		}
		if (spotifyRateLimit.shouldThrottle()) {
			return "rate_limited";
		}
		return "ok";
	}

	private resolveDisplayApiStatus(track: SpotifyTrack, fetchStatus: SpotifyLikeApiStatus): SpotifyLikeApiStatus {
		if (fetchStatus === "no_auth") {
			return "no_auth";
		}
		if (this.getCachedLikeForTrack(track)) {
			return "ok";
		}
		return fetchStatus;
	}

	private updateLikeApiStatus(status: SpotifyLikeApiStatus): void {
		if (this.currentState.likeApiStatus === status) {
			return;
		}
		streamDeck.logger.info(`[Spotify] Like API status -> ${status}`);
		this.currentState = { ...this.currentState, likeApiStatus: status };
		this.emit(this.currentState);
	}

	refreshLikeApiStatus(): void {
		this.updateLikeApiStatus(this.probeLikeApiStatus(this.currentState.track));
	}

	/** Keep geo status after a failed manual like - probe would wrongly reset to ok */
	markGeoBlocked(): void {
		this.updateLikeApiStatus("geo_blocked");
		const track = this.currentState.track;
		if (track) {
			this.scheduleDegradedRecovery(track);
		}
	}

	private async enrichIsLiked(track: SpotifyTrack, reason: string): Promise<void> {
		const trackId = track.id;
		const trackCtx = { title: track.name, artist: track.artist };

		const uri = spotifyAPI.getCachedUri(track.id);
		const hasLikeCache =
			Boolean(uri) &&
			Boolean(this.likedByUriCache.get(uri!)) &&
			spotifyAPI.isPlayerConfirmed(track.id);
		// Grace only after a real track->track skip while playing - not cold start / paused bootstrap
		const withinCacheGrace =
			this.lastTrackChangeWasSwitch &&
			track.isPlaying &&
			Date.now() - this.lastTrackChangedAt < LIKE_CACHE_HIT_GRACE_MS;

		if (
			(reason === "track-changed" || reason === "like-button-appear") &&
			hasLikeCache &&
			withinCacheGrace
		) {
			spotifyApiMetrics.recordPolicySkip(
				`${reason}:cache-grace`,
				"/me/library/contains",
				"library",
				trackCtx
			);
			streamDeck.logger.debug(
				`[Spotify] Like check (${reason}): skipping cache-hit for "${track.name}" - track changed ${Math.ceil((Date.now() - this.lastTrackChangedAt) / 1000)}s ago`
			);
		} else if (
			(reason === "track-changed" || reason === "like-button-appear") &&
			hasLikeCache
		) {
			const cached = this.likedByUriCache.get(uri!)!;
			spotifyApiMetrics.recordPolicySkip(
				`${reason}:cache-hit`,
				"/me/library/contains",
				"library",
				trackCtx
			);
			streamDeck.logger.debug(
				`[Spotify] Like check (${reason}): cache-hit for "${track.name}" (${cached.isLiked ? "liked" : "not liked"}) uri=${uri} - 0 API`
			);
			this.currentState = {
				...this.currentState,
				isLiked: cached.isLiked,
				likeKnown: true,
				likeApiStatus: "ok"
			};
			this.emit(this.currentState);
			this.clearDegradedRecovery();
			return;
		}

		if (reason === "retry" && spotifyRateLimit.shouldThrottle()) {
			spotifyApiMetrics.recordPolicySkip(`${reason}:server-blocked`, "/me/library/contains", "library", trackCtx);
			this.scheduleLikeRetry(track, reason);
			this.scheduleDegradedRecovery(track);
			return;
		}

		if (
			spotifyApiGateway.isDailyBackgroundBudgetExhausted() &&
			!BYPASS_DAILY_BUDGET_REASONS.has(reason)
		) {
			spotifyApiMetrics.recordPolicySkip(`${reason}:daily-budget`, "/me/library/contains", "library", trackCtx);
			const cachedDaily = this.getCachedLikeForTrack(track);
			if (cachedDaily) {
				this.currentState = {
					...this.currentState,
					isLiked: cachedDaily.isLiked,
					likeKnown: true,
					likeApiStatus: "ok"
				};
				this.emit(this.currentState);
				this.clearDegradedRecovery();
			} else {
				this.updateLikeApiStatus("unavailable");
				this.scheduleDegradedRecovery(track);
			}
			return;
		}

		if (Date.now() < this.likeSkipUntil) {
			spotifyApiMetrics.recordPolicySkip(`${reason}:toggle-cooldown`, "/me/library/contains", "library", trackCtx);
			streamDeck.logger.debug(`[Spotify] Like check skipped (${reason}): recent toggle`);
			return;
		}
		if (this.likedCheckInFlight) {
			spotifyApiMetrics.recordPolicySkip(`${reason}:in-flight`, "/me/library/contains", "library", trackCtx);
			streamDeck.logger.debug(`[Spotify] Like check skipped (${reason}): request in flight`);
			return;
		}

		await loadSpotifySettings();

		if (!getSpotifySettings().refreshToken) {
			this.updateLikeApiStatus("no_auth");
			return;
		}

		const cached = this.getCachedLikeForTrack(track);

		if (spotifyRateLimit.shouldThrottle()) {
			spotifyApiMetrics.recordPolicySkip(`${reason}:backoff`, "/me/library/contains", "library", trackCtx);
			const displayStatus = this.resolveDisplayApiStatus(track, "rate_limited");
			this.updateLikeApiStatus(displayStatus);
			if (cached) {
				streamDeck.logger.info(
					`[Spotify] Using cached like for "${track.name}" (${cached.isLiked ? "liked" : "not liked"}) during API backoff`
				);
				this.currentState = {
					...this.currentState,
					isLiked: cached.isLiked,
					likeKnown: true,
					likeApiStatus: displayStatus
				};
				this.emit(this.currentState);
			}
			this.scheduleLikeRetry(track, reason);
			this.scheduleDegradedRecovery(track);
			return;
		}

		if (cached) {
			this.currentState = {
				...this.currentState,
				isLiked: cached.isLiked,
				likeKnown: true,
				likeApiStatus: "ok"
			};
			this.emit(this.currentState);
			this.clearDegradedRecovery();
		}

		const bypassQuota = BYPASS_DAILY_BUDGET_REASONS.has(reason);
		const isLiked = await this.fetchIsLiked(track, reason, bypassQuota);
		const resolvedUri = spotifyAPI.getCachedUri(trackId) ?? "unknown";
		if (trackId !== this.lastTrackId || !this.currentState.track) {
			return;
		}

		if (isLiked === null) {
			const lastError = spotifyApiGateway.getLastError();
			const fetchStatus: SpotifyLikeApiStatus =
				lastError === "geo_blocked"
					? "geo_blocked"
					: spotifyRateLimit.shouldThrottle()
						? "rate_limited"
						: "unavailable";
			const displayStatus = this.resolveDisplayApiStatus(track, fetchStatus);

			// Soft-display last known like during geo/VPN blocks so the key is not stuck on !
			if (fetchStatus === "geo_blocked") {
				const soft = this.getCachedLike(trackId) ?? this.getCachedLikeForTrack(track) ?? cached;
				if (soft) {
					streamDeck.logger.info(
						`[Spotify] Using soft cached like for "${track.name}" during geo block (${soft.isLiked ? "liked" : "not liked"})`
					);
					this.currentState = {
						...this.currentState,
						isLiked: soft.isLiked,
						likeKnown: true,
						likeApiStatus: "geo_blocked"
					};
					this.emit(this.currentState);
				} else {
					this.updateLikeApiStatus("geo_blocked");
				}
				// No short retry - geo clears slowly
				this.scheduleDegradedRecovery(track);
				return;
			}

			this.updateLikeApiStatus(displayStatus);

			if (cached) {
				streamDeck.logger.info(
					`[Spotify] Using cached like for "${track.name}" (${cached.isLiked ? "liked" : "not liked"}) after fetch failure`
				);
				this.currentState = {
					...this.currentState,
					isLiked: cached.isLiked,
					likeKnown: true,
					likeApiStatus: displayStatus
				};
				this.emit(this.currentState);
			}

			this.scheduleLikeRetry(track, reason);
			this.scheduleDegradedRecovery(track);
			return;
		}

		this.rememberLiked(trackId, isLiked);
		this.updateLikeApiStatus("ok");
		this.clearDegradedRecovery();

		if (this.currentState.isLiked === isLiked && this.currentState.likeKnown) {
			streamDeck.logger.debug(
				`[Spotify] Like check (${reason}): "${track.name}" by "${track.artist}" uri=${resolvedUri} unchanged (${isLiked ? "liked" : "not liked"})`
			);
			return;
		}

		streamDeck.logger.info(
			`[Spotify] Like check (${reason}): "${track.name}" by "${track.artist}" uri=${resolvedUri} -> ${isLiked ? "liked" : "not liked"}`
		);
		this.currentState = {
			...this.currentState,
			isLiked,
			likeKnown: true,
			likeApiStatus: "ok"
		};
		this.emit(this.currentState);
	}

	private async fetchIsLiked(
		track: SpotifyTrack,
		reason: string,
		bypassQuota = false
	): Promise<boolean | null> {
		const settings = getSpotifySettings();
		if (!settings.refreshToken) {
			streamDeck.logger.warn(
				`[Spotify] Like check failed (${reason}): no refresh token - open Spotify Setup and authorize`
			);
			return null;
		}

		const oldUri = spotifyAPI.getCachedUri(track.id);
		this.likedCheckInFlight = true;
		try {
			const result = await spotifyAPI.isTrackLiked(settings, track, reason, {
				bypassQuota
			});
			const newUri = spotifyAPI.getCachedUri(track.id);
			if (newUri && oldUri && newUri !== oldUri) {
				this.likedResultCache.delete(track.id);
				this.likedByUriCache.delete(oldUri);
				this.persistLikedCache();
				streamDeck.logger.info(
					`[Spotify] URI changed for "${track.name}": ${oldUri} -> ${newUri}, cleared liked cache`
				);
			}
			return result;
		} finally {
			this.likedCheckInFlight = false;
		}
	}

	setPlayingOptimistic(isPlaying: boolean): void {
		if (!this.currentState.track) return;
		if (this.currentState.track.isPlaying === isPlaying) return;
		this.playingOptimisticUntil = Date.now() + PLAYING_OPTIMISTIC_HOLD_MS;
		this.lastWasPlaying = isPlaying;
		if (isPlaying) {
			this.lastPlayingTrueAt = Date.now();
			this.pausedSince = 0;
		} else {
			this.pausedSince = Date.now();
			this.autoAdvancePlayingUntil = 0;
		}
		const track = { ...this.currentState.track, isPlaying };
		this.currentState = { ...this.currentState, track };
		this.emit(this.currentState);
	}

	setLikedOptimistic(isLiked: boolean): void {
		if (!this.currentState.track) return;
		if (this.currentState.isLiked === isLiked) return;
		this.likeSkipUntil = Date.now() + LIKE_SKIP_AFTER_TOGGLE_MS;
		this.rememberLiked(this.currentState.track.id, isLiked);
		this.currentState = {
			...this.currentState,
			isLiked,
			likeKnown: true,
			likeApiStatus: "ok"
		};
		this.emit(this.currentState);
	}

	getCachedTrack(): SpotifyTrack | null {
		return this.currentState.track;
	}

	getState(): SpotifyPlaybackState {
		return this.currentState;
	}
}

export const spotifyState = new SpotifyState();
