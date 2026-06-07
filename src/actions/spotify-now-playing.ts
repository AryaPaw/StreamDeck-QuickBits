import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import {
	buildOverlayFromBase64,
	buildPausedOverlay,
	buildPlayingImage,
	prebuildPausedOverlay,
	resolveTrackArtPath
} from "../shared/spotify/artwork-overlay";
import {
	spotifyLocalClient,
	spotifyState,
	SpotifyPlaybackState,
	SpotifyTrack
} from "../shared/spotify";

const PLACEHOLDER_IMAGE = "imgs/actions/spotify/key";
const OVERLAY_PAUSE_DEBOUNCE_MS = 500;
const PLAYING_GUARD_MS = 800;
const TRACK_TRANSITION_MS = 2_000;

@action({ UUID: "dev.aryapaw.quickbits.spotify-now-playing" })
export class SpotifyNowPlayingAction extends SingletonAction {
	private currentAction: WillAppearEvent["action"] | null = null;
	private unsubscribe: (() => void) | null = null;
	private lastTrackId: string | null = null;
	private cachedArtKey: string | null = null;
	private cachedOverlayImage: string | null = null;
	private cachedIsPlaying: boolean | null = null;
	private heldOverlayImage: string | null = null;
	private displayedIsPlaying = false;
	private pauseOverlayTimer: ReturnType<typeof setTimeout> | null = null;
	private optimisticUntil = 0;
	private playingGuardUntil = 0;
	private trackTransitionUntil = 0;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		this.unsubscribe = spotifyState.subscribe((state) => this.onStateChange(state));
	}

	override async onWillDisappear(): Promise<void> {
		this.clearPauseOverlayTimer();
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const { track } = spotifyState.getState();
		if (!track) {
			await ev.action.showAlert();
			return;
		}

		const nextPlaying = !track.isPlaying;
		this.optimisticUntil = Date.now() + 2_000;
		this.clearPauseOverlayTimer();
		this.playingGuardUntil = nextPlaying ? Date.now() + PLAYING_GUARD_MS : 0;
		spotifyState.setPlayingOptimistic(nextPlaying);
		await this.applyDisplay(track, nextPlaying);

		const success = await spotifyLocalClient.togglePlayPause();
		if (!success) {
			this.playingGuardUntil = track.isPlaying ? Date.now() + PLAYING_GUARD_MS : 0;
			spotifyState.setPlayingOptimistic(track.isPlaying);
			await this.applyDisplay(track, track.isPlaying);
			await ev.action.showAlert();
		}
	}

	private clearPauseOverlayTimer(): void {
		if (this.pauseOverlayTimer) {
			clearTimeout(this.pauseOverlayTimer);
			this.pauseOverlayTimer = null;
		}
	}

	private beginTrackTransition(): void {
		this.trackTransitionUntil = Date.now() + TRACK_TRANSITION_MS;
		this.clearPauseOverlayTimer();
		this.displayedIsPlaying = true;
		this.playingGuardUntil = Date.now() + PLAYING_GUARD_MS;
		if (this.cachedOverlayImage) {
			this.heldOverlayImage = this.cachedOverlayImage;
		}
		this.cachedArtKey = null;
		this.cachedIsPlaying = null;
	}

	private isInTrackTransition(): boolean {
		return Date.now() < this.trackTransitionUntil;
	}

	private async onStateChange(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;

		const { track } = state;

		if (!track) {
			this.clearPauseOverlayTimer();
			this.lastTrackId = null;
			this.cachedArtKey = null;
			this.cachedOverlayImage = null;
			this.cachedIsPlaying = null;
			this.heldOverlayImage = null;
			this.displayedIsPlaying = false;
			this.playingGuardUntil = 0;
			this.trackTransitionUntil = 0;
			await this.currentAction.setTitle("");
			await this.currentAction.setImage(PLACEHOLDER_IMAGE);
			return;
		}

		await this.currentAction.setTitle("");

		if (this.lastTrackId !== track.id) {
			this.lastTrackId = track.id;
			this.beginTrackTransition();
		}

		if (Date.now() < this.optimisticUntil) {
			await this.applyDisplay(track, track.isPlaying);
			return;
		}

		if (track.isPlaying || this.isInTrackTransition()) {
			this.clearPauseOverlayTimer();
			await this.applyDisplay(track, true);
			return;
		}

		if (Date.now() < this.playingGuardUntil) {
			return;
		}

		if (!this.displayedIsPlaying) {
			return;
		}

		this.clearPauseOverlayTimer();
		this.pauseOverlayTimer = setTimeout(() => {
			this.pauseOverlayTimer = null;
			const current = spotifyState.getState().track;
			if (!current || current.isPlaying) {
				return;
			}
			if (Date.now() < this.playingGuardUntil || this.isInTrackTransition()) {
				return;
			}
			void this.applyDisplay(current, false);
		}, OVERLAY_PAUSE_DEBOUNCE_MS);
	}

	private async applyDisplay(track: SpotifyTrack, isPlaying: boolean): Promise<void> {
		if (this.displayedIsPlaying === isPlaying) {
			const artPath = resolveTrackArtPath(track.albumArtPath);
			const artKey = `${track.id}:${artPath ?? track.albumArtBase64?.slice(0, 32) ?? ""}:${isPlaying}`;
			if (
				this.cachedArtKey === artKey &&
				this.cachedOverlayImage !== null &&
				this.cachedIsPlaying === isPlaying
			) {
				return;
			}
		}

		await this.renderTrack(track, isPlaying);
		this.displayedIsPlaying = isPlaying;
		if (isPlaying) {
			this.playingGuardUntil = Date.now() + PLAYING_GUARD_MS;
		}
	}

	private async renderTrack(track: SpotifyTrack, isPlaying: boolean): Promise<void> {
		if (!this.currentAction) return;

		const artPath = resolveTrackArtPath(track.albumArtPath);
		const artKey = `${track.id}:${artPath ?? track.albumArtBase64?.slice(0, 32) ?? ""}:${isPlaying}`;

		if (
			this.cachedArtKey === artKey &&
			this.cachedOverlayImage !== null &&
			this.cachedIsPlaying === isPlaying
		) {
			await this.currentAction.setImage(this.cachedOverlayImage);
			return;
		}

		if (!artPath && !track.albumArtBase64) {
			if (this.heldOverlayImage) {
				await this.currentAction.setImage(this.heldOverlayImage);
				return;
			}
			await this.currentAction.setImage(PLACEHOLDER_IMAGE);
			return;
		}

		const image = this.resolveKeyImage(track, artPath, isPlaying);
		if (!image) {
			if (this.heldOverlayImage) {
				await this.currentAction.setImage(this.heldOverlayImage);
				return;
			}
			if (this.cachedOverlayImage) {
				await this.currentAction.setImage(this.cachedOverlayImage);
			} else {
				await this.currentAction.setImage(PLACEHOLDER_IMAGE);
			}
			return;
		}

		this.cachedArtKey = artKey;
		this.cachedOverlayImage = image;
		this.cachedIsPlaying = isPlaying;
		this.heldOverlayImage = image;
		await this.currentAction.setImage(image);

		if (artPath && isPlaying) {
			prebuildPausedOverlay(artPath);
		}
	}

	private resolveKeyImage(
		track: SpotifyTrack,
		artPath: string | null,
		isPlaying: boolean
	): string | null {
		if (artPath) {
			if (isPlaying) {
				return buildPlayingImage(artPath);
			}

			const paused = buildPausedOverlay(artPath);
			if (paused) {
				return paused;
			}

			return buildPlayingImage(artPath);
		}

		if (track.albumArtBase64) {
			try {
				return buildOverlayFromBase64(
					track.albumArtBase64,
					track.albumArtMime || "image/jpeg",
					isPlaying
				);
			} catch {
				return null;
			}
		}

		return null;
	}
}
