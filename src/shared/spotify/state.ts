import streamDeck from "@elgato/streamdeck";
import { getSpotifySettings, loadSpotifySettings } from "./settings";
import { spotifyAPI } from "./api";
import { spotifyRateLimit } from "./rate-limit";
import { spotifyLocalClient } from "./local/client";
import { mapLocalStateToTrack } from "./local/map";
import type { SpotifyLocalState } from "./local/types";
import type {
	SpotifyLikeApiStatus,
	SpotifyPlaybackState,
	SpotifyTrack,
	StateListener
} from "./types";

const TRANSITION_HOLD_MS = 1000;
const TRANSPORT_PLAYING_GRACE_MS = 500;
const LIKE_SYNC_INTERVAL_MS = 60_000;
const LIKE_PLAYING_DEBOUNCE_MS = 3_000;
const LIKE_SKIP_AFTER_TOGGLE_MS = 5_000;
const PLAYING_OPTIMISTIC_HOLD_MS = 2_000;

class SpotifyState {
	private listeners: Set<StateListener> = new Set();
	private unsubscribeLocal: (() => void) | null = null;
	private currentState: SpotifyPlaybackState = {
		track: null,
		isLiked: false,
		likeApiStatus: "ok"
	};
	private lastTrackId: string | null = null;
	private lastTrackAt = 0;
	private lastWasPlaying = false;
	private likedCheckInFlight = false;
	private likeSyncRefs = 0;
	private likeSyncTimer: ReturnType<typeof setInterval> | null = null;
	private likePlayingDebounce: ReturnType<typeof setTimeout> | null = null;
	private likeRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private likeRecoveryWatch: ReturnType<typeof setInterval> | null = null;
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
			this.startLikeSyncTimer();
			this.startLikeApiRecoveryWatch();
		}
		this.refreshLikeApiStatus();
		const track = this.currentState.track;
		if (!track) {
			return;
		}
		if (this.currentState.likeApiStatus === "ok" && !spotifyRateLimit.shouldThrottle()) {
			void this.enrichIsLiked(track, "like-button-appear");
		} else {
			this.scheduleLikeRetry(track, "like-button-appear");
		}
	}

	unregisterLikeSync(): void {
		this.likeSyncRefs = Math.max(0, this.likeSyncRefs - 1);
		if (this.likeSyncRefs === 0) {
			this.stopLikeSyncTimer();
			this.stopLikeApiRecoveryWatch();
		}
	}

	private emit(state: SpotifyPlaybackState): void {
		for (const listener of this.listeners) {
			listener(state);
		}
	}

	private applyPlayingGrace(track: SpotifyTrack, local: SpotifyLocalState): SpotifyTrack {
		const playbackState = local.player.state;

		if (playbackState === "playing") {
			this.lastWasPlaying = true;
			return { ...track, isPlaying: true };
		}

		if (
			(playbackState === "paused" || playbackState === "unknown") &&
			spotifyLocalClient.wasRecentSkipTransport(TRANSPORT_PLAYING_GRACE_MS)
		) {
			return { ...track, isPlaying: true };
		}

		if (playbackState === "paused" || playbackState === "stopped") {
			this.lastWasPlaying = false;
		}

		return { ...track, isPlaying: false };
	}

	private async processLocalState(local: SpotifyLocalState): Promise<void> {
		let track = mapLocalStateToTrack(local);
		let isLiked = this.currentState.isLiked;
		let trackChanged = false;

		if (!track) {
			if (this.currentState.track && Date.now() - this.lastTrackAt < TRANSITION_HOLD_MS) {
				track = this.applyPlayingGrace(this.currentState.track, local);
			} else {
				this.lastTrackId = null;
				isLiked = false;
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
				const wasPlaying = this.currentState.track?.isPlaying ?? this.lastWasPlaying;
				this.lastTrackId = track.id;
				trackChanged = true;
				isLiked = false;

				if (wasPlaying) {
					this.lastWasPlaying = true;
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

		const playingChanged = this.currentState.track?.isPlaying !== track?.isPlaying;
		const likedChanged = this.currentState.isLiked !== isLiked;
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
			playingChanged ||
			likedChanged ||
			artChanged ||
			metaChanged ||
			(track === null && hadTrack)
		) {
			this.currentState = { ...this.currentState, track, isLiked };
			this.emit(this.currentState);
		}

		if (trackChanged && track) {
			void spotifyLocalClient.refreshArtwork();
			if (this.likeSyncRefs > 0 && !this.likeRetryTimer && !spotifyRateLimit.shouldThrottle()) {
				void this.enrichIsLiked(track, "track-changed");
			} else if (this.likeSyncRefs > 0) {
				this.refreshLikeApiStatus();
				this.scheduleLikeRetry(track, "track-changed");
			}
		} else if (playingChanged && track) {
			this.scheduleLikeRefreshOnPlayingChange(track);
		}
	}

	private startLikeSyncTimer(): void {
		this.stopLikeSyncTimer();
		this.likeSyncTimer = setInterval(() => {
			const track = this.currentState.track;
			if (!track || this.likeSyncRefs === 0) {
				return;
			}
			if (Date.now() < this.likeSkipUntil || this.likeRetryTimer) {
				return;
			}
			if (spotifyRateLimit.shouldThrottle()) {
				this.updateLikeApiStatus("rate_limited");
				this.scheduleLikeRetry(track, "interval");
				return;
			}
			void this.enrichIsLiked(track, "interval");
		}, LIKE_SYNC_INTERVAL_MS);
	}

	private startLikeApiRecoveryWatch(): void {
		if (this.likeRecoveryWatch) {
			return;
		}

		this.likeRecoveryWatch = setInterval(() => {
			if (this.likeSyncRefs === 0) {
				return;
			}
			if (this.currentState.likeApiStatus === "ok") {
				return;
			}
			if (spotifyRateLimit.shouldThrottle()) {
				this.updateLikeApiStatus("rate_limited");
				return;
			}

			const track = this.currentState.track;
			if (!track || this.likedCheckInFlight || this.likeRetryTimer) {
				return;
			}

			void this.enrichIsLiked(track, "recovery-watch");
		}, 5_000);
	}

	private stopLikeApiRecoveryWatch(): void {
		if (this.likeRecoveryWatch) {
			clearInterval(this.likeRecoveryWatch);
			this.likeRecoveryWatch = null;
		}
	}

	private stopLikeSyncTimer(): void {
		if (this.likeSyncTimer) {
			clearInterval(this.likeSyncTimer);
			this.likeSyncTimer = null;
		}
		if (this.likePlayingDebounce) {
			clearTimeout(this.likePlayingDebounce);
			this.likePlayingDebounce = null;
		}
		if (this.likeRetryTimer) {
			clearTimeout(this.likeRetryTimer);
			this.likeRetryTimer = null;
		}
		this.stopLikeApiRecoveryWatch();
	}

	private scheduleLikeRetry(track: SpotifyTrack, reason: string): void {
		if (this.likeSyncRefs === 0 || this.likeRetryTimer) {
			return;
		}

		const delay = Math.max(2_000, spotifyRateLimit.msUntilReady() + 1_000);

		streamDeck.logger.info(
			`[Spotify] Like check retry (${reason}) for "${track.name}" in ${Math.ceil(delay / 1000)}s`
		);

		this.likeRetryTimer = setTimeout(() => {
			this.likeRetryTimer = null;
			const current = this.currentState.track;
			if (!current || current.id !== track.id || this.likeSyncRefs === 0) {
				return;
			}
			void this.enrichIsLiked(current, `${reason}-retry`);
		}, delay);
	}

	private probeLikeApiStatus(): SpotifyLikeApiStatus {
		const settings = getSpotifySettings();
		if (!settings.refreshToken) {
			return "no_auth";
		}
		if (spotifyRateLimit.shouldThrottle()) {
			return "rate_limited";
		}
		return "ok";
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
		this.updateLikeApiStatus(this.probeLikeApiStatus());
	}

	private scheduleLikeRefreshOnPlayingChange(track: SpotifyTrack): void {
		if (this.likeSyncRefs === 0) {
			return;
		}
		if (Date.now() < this.likeSkipUntil) {
			return;
		}

		if (this.likePlayingDebounce) {
			clearTimeout(this.likePlayingDebounce);
		}

		this.likePlayingDebounce = setTimeout(() => {
			this.likePlayingDebounce = null;
			if (track.id !== this.lastTrackId || !this.currentState.track) {
				return;
			}
			void this.enrichIsLiked(this.currentState.track, "playing-changed");
		}, LIKE_PLAYING_DEBOUNCE_MS);
	}

	private async enrichIsLiked(track: SpotifyTrack, reason: string): Promise<void> {
		const trackId = track.id;
		if (Date.now() < this.likeSkipUntil) {
			streamDeck.logger.debug(`[Spotify] Like check skipped (${reason}): recent toggle`);
			return;
		}
		if (this.likedCheckInFlight) {
			streamDeck.logger.debug(`[Spotify] Like check skipped (${reason}): request in flight`);
			return;
		}

		await loadSpotifySettings();
		const authStatus = this.probeLikeApiStatus();
		if (authStatus !== "ok") {
			this.updateLikeApiStatus(authStatus);
			this.scheduleLikeRetry(track, reason);
			return;
		}

		const isLiked = await this.fetchIsLiked(track, reason);
		if (isLiked === null) {
			this.updateLikeApiStatus(
				spotifyRateLimit.shouldThrottle() ? "rate_limited" : "unavailable"
			);
			this.scheduleLikeRetry(track, reason);
			return;
		}
		if (trackId !== this.lastTrackId || !this.currentState.track) {
			return;
		}

		this.updateLikeApiStatus("ok");

		if (this.currentState.isLiked === isLiked) {
			streamDeck.logger.debug(
				`[Spotify] Like check (${reason}): "${track.name}" unchanged (${isLiked ? "liked" : "not liked"})`
			);
			return;
		}
		streamDeck.logger.info(
			`[Spotify] Like check (${reason}): "${track.name}" -> ${isLiked ? "liked" : "not liked"}`
		);
		this.currentState = { ...this.currentState, isLiked };
		this.emit(this.currentState);
	}

	private async fetchIsLiked(track: SpotifyTrack, reason: string): Promise<boolean | null> {
		const settings = getSpotifySettings();
		if (!settings.refreshToken) {
			streamDeck.logger.warn(
				`[Spotify] Like check failed (${reason}): no refresh token - open Spotify Setup and authorize`
			);
			return null;
		}

		this.likedCheckInFlight = true;
		try {
			return await spotifyAPI.isTrackLiked(settings, track, reason);
		} finally {
			this.likedCheckInFlight = false;
		}
	}

	setPlayingOptimistic(isPlaying: boolean): void {
		if (!this.currentState.track) return;
		if (this.currentState.track.isPlaying === isPlaying) return;
		this.playingOptimisticUntil = Date.now() + PLAYING_OPTIMISTIC_HOLD_MS;
		this.lastWasPlaying = isPlaying;
		const track = { ...this.currentState.track, isPlaying };
		this.currentState = { ...this.currentState, track };
		this.emit(this.currentState);
	}

	setLikedOptimistic(isLiked: boolean): void {
		if (!this.currentState.track) return;
		if (this.currentState.isLiked === isLiked) return;
		this.likeSkipUntil = Date.now() + LIKE_SKIP_AFTER_TOGGLE_MS;
		this.currentState = { ...this.currentState, isLiked };
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
