import streamDeck from "@elgato/streamdeck";
import { getSpotifySettings, loadSpotifySettings, saveSpotifySettings } from "./settings";
import { spotifyAPI } from "./api";
import { spotifyApiMetrics } from "./api-metrics";
import { spotifyRateLimit } from "./rate-limit";
import { spotifyLocalClient } from "./local/client";
import { mapLocalStateToTrack } from "./local/map";
import type { SpotifyLocalState } from "./local/types";
import type {
	SpotifyLikeApiStatus,
	SpotifyPlaybackState,
	SpotifySettings,
	SpotifyTrack,
	StateListener
} from "./types";

const TRANSITION_HOLD_MS = 2_000;
const AUTO_ADVANCE_PLAYING_MS = 5_000;
const PAUSED_CLEAR_MS = 3_000;
const TRANSPORT_PLAYING_GRACE_MS = 500;
const LIKE_SKIP_AFTER_TOGGLE_MS = 5_000;
const MAX_LIKE_RETRIES = 2;
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
	private lastWasPlaying = false;
	private lastPlayingTrueAt = 0;
	private pausedSince = 0;
	private autoAdvancePlayingUntil = 0;
	private likedCheckInFlight = false;
	private likedResultCache = new Map<string, LikedCacheEntry>();
	private likeSyncRefs = 0;
	private likeRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private likeRetryCount = 0;
	private likeRetryTrackId: string | null = null;
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

	registerLikeSync(): void {
		this.likeSyncRefs += 1;
		if (this.likeSyncRefs === 1) {
			void this.bootstrapLikeSync();
		}
	}

	unregisterLikeSync(): void {
		this.likeSyncRefs = Math.max(0, this.likeSyncRefs - 1);
		if (this.likeSyncRefs === 0) {
			this.stopLikeTimers();
		}
	}

	private async bootstrapLikeSync(): Promise<void> {
		const settings = await loadSpotifySettings();
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
		this.likedResultCache.set(trackId, { isLiked, at: Date.now() });
		this.persistLikedCache();
	}

	private emit(state: SpotifyPlaybackState): void {
		for (const listener of this.listeners) {
			listener(state);
		}
	}

	private getCachedLike(trackId: string): LikedCacheEntry | null {
		return this.likedResultCache.get(trackId) ?? null;
	}

	private applyCachedLikeIfAny(track: SpotifyTrack): boolean {
		const cached = this.getCachedLike(track.id);
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
				this.lastTrackId = track.id;
				trackChanged = true;
				this.pausedSince = 0;
				this.likeRetryCount = 0;
				this.likeRetryTrackId = track.id;
				if (this.likeRetryTimer) {
					clearTimeout(this.likeRetryTimer);
					this.likeRetryTimer = null;
				}

				const cached = this.getCachedLike(track.id);
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
			} else if (this.currentState.track) {
				track = {
					...track,
					artist: track.artist || this.currentState.track.artist,
					album: track.album || this.currentState.track.album,
					albumArtPath: track.albumArtPath ?? this.currentState.track.albumArtPath,
					albumArtBase64: track.albumArtBase64 ?? this.currentState.track.albumArtBase64,
					albumArtMime: track.albumArtMime ?? this.currentState.track.albumArtMime
				};
			}
		}

		const playbackStateChanged = this.currentState.playbackState !== playbackState;
		const playingChanged = this.currentState.track?.isPlaying !== track?.isPlaying;
		const likedChanged =
			this.currentState.isLiked !== isLiked || this.currentState.likeKnown !== likeKnown;
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
			this.currentState = { ...this.currentState, track, playbackState, isLiked, likeKnown };
			this.emit(this.currentState);
		}

		if (trackChanged && track && this.likeSyncRefs > 0) {
			void spotifyLocalClient.refreshArtwork();
			void this.enrichIsLiked(track, "track-changed");
		}
	}

	private stopLikeTimers(): void {
		if (this.likeRetryTimer) {
			clearTimeout(this.likeRetryTimer);
			this.likeRetryTimer = null;
		}
	}

	private resetLikeRetryState(trackId: string): void {
		if (this.likeRetryTrackId !== trackId) {
			this.likeRetryTrackId = trackId;
			this.likeRetryCount = 0;
		}
	}

	private scheduleLikeRetry(track: SpotifyTrack, reason: string): void {
		if (this.likeSyncRefs === 0 || this.likeRetryTimer) {
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

		const delay = Math.max(2_000, spotifyRateLimit.msUntilReady() + 500);

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
		if (track && this.getCachedLike(track.id)) {
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
		if (this.getCachedLike(track.id)) {
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

	private async enrichIsLiked(track: SpotifyTrack, reason: string): Promise<void> {
		const trackId = track.id;
		const trackCtx = { title: track.name, artist: track.artist };
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

		const cached = this.getCachedLike(trackId);
		const uriCached = spotifyAPI.hasCachedUri(trackId);

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
			return;
		}

		if (uriCached && cached) {
			this.currentState = {
				...this.currentState,
				isLiked: cached.isLiked,
				likeKnown: true,
				likeApiStatus: "ok"
			};
			this.emit(this.currentState);
		}

		const isLiked = await this.fetchIsLiked(track, reason, uriCached);
		if (trackId !== this.lastTrackId || !this.currentState.track) {
			return;
		}

		if (isLiked === null) {
			const fetchStatus: SpotifyLikeApiStatus = spotifyRateLimit.shouldThrottle()
				? "rate_limited"
				: "unavailable";
			const displayStatus = this.resolveDisplayApiStatus(track, fetchStatus);
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
			return;
		}

		this.rememberLiked(trackId, isLiked);
		this.updateLikeApiStatus("ok");

		if (this.currentState.isLiked === isLiked && this.currentState.likeKnown) {
			streamDeck.logger.debug(
				`[Spotify] Like check (${reason}): "${track.name}" unchanged (${isLiked ? "liked" : "not liked"})`
			);
			return;
		}

		streamDeck.logger.info(
			`[Spotify] Like check (${reason}): "${track.name}" -> ${isLiked ? "liked" : "not liked"}`
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
		uriCached: boolean
	): Promise<boolean | null> {
		const settings = getSpotifySettings();
		if (!settings.refreshToken) {
			streamDeck.logger.warn(
				`[Spotify] Like check failed (${reason}): no refresh token - open Spotify Setup and authorize`
			);
			return null;
		}

		this.likedCheckInFlight = true;
		try {
			return await spotifyAPI.isTrackLiked(settings, track, reason, {
				skipSearch: uriCached
			});
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
