import { getSpotifySettings } from "./settings";
import { spotifyAPI } from "./api";
import { spotifyLocalClient } from "./local/client";
import { mapLocalStateToTrack } from "./local/map";
import type { SpotifyLocalState } from "./local/types";
import type { SpotifyPlaybackState, SpotifyTrack, StateListener } from "./types";

const TRANSITION_HOLD_MS = 1000;
const PLAYING_GRACE_MS = 2000;

class SpotifyState {
	private listeners: Set<StateListener> = new Set();
	private unsubscribeLocal: (() => void) | null = null;
	private currentState: SpotifyPlaybackState = { track: null, isLiked: false };
	private lastTrackId: string | null = null;
	private lastTrackAt = 0;
	private playingGraceUntil = 0;
	private lastWasPlaying = false;
	private likedCheckInFlight = false;
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

	private emit(state: SpotifyPlaybackState): void {
		for (const listener of this.listeners) {
			listener(state);
		}
	}

	private applyPlayingGrace(track: SpotifyTrack, local: SpotifyLocalState): SpotifyTrack {
		const playbackState = local.player.state;
		const now = Date.now();

		if (playbackState === "playing") {
			this.lastWasPlaying = true;
			this.playingGraceUntil = 0;
			return { ...track, isPlaying: true };
		}

		if (
			(playbackState === "paused" || playbackState === "unknown") &&
			now < this.playingGraceUntil
		) {
			return { ...track, isPlaying: true };
		}

		if (playbackState === "paused" || playbackState === "stopped") {
			this.lastWasPlaying = false;
			this.playingGraceUntil = 0;
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
			this.lastTrackAt = Date.now();

			if (track.id !== this.lastTrackId) {
				const wasPlaying = this.currentState.track?.isPlaying ?? this.lastWasPlaying;
				this.lastTrackId = track.id;
				trackChanged = true;
				isLiked = false;

				if (wasPlaying) {
					this.playingGraceUntil = Date.now() + PLAYING_GRACE_MS;
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
			this.currentState = { track, isLiked };
			this.emit(this.currentState);
		}

		if (trackChanged && track) {
			void spotifyLocalClient.refreshArtwork();
			void this.enrichIsLiked(track);
		} else if (artChanged && track) {
			void spotifyLocalClient.refreshArtwork();
		}
	}

	private async enrichIsLiked(track: SpotifyTrack): Promise<void> {
		const trackId = track.id;
		const isLiked = await this.fetchIsLiked(track);
		if (trackId !== this.lastTrackId || !this.currentState.track) {
			return;
		}
		if (this.currentState.isLiked === isLiked) {
			return;
		}
		this.currentState = { ...this.currentState, isLiked };
		this.emit(this.currentState);
	}

	private async fetchIsLiked(track: SpotifyTrack): Promise<boolean> {
		const settings = getSpotifySettings();
		if (!settings.refreshToken || this.likedCheckInFlight) {
			return false;
		}

		this.likedCheckInFlight = true;
		try {
			return await spotifyAPI.isTrackLiked(settings, track);
		} finally {
			this.likedCheckInFlight = false;
		}
	}

	setLikedOptimistic(isLiked: boolean): void {
		if (!this.currentState.track) return;
		if (this.currentState.isLiked === isLiked) return;
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
