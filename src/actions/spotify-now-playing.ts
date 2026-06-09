import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { buildNowPlayingKeyImage } from "../shared/spotify/artwork-overlay";
import {
	spotifyLocalClient,
	spotifyState,
	SpotifyPlaybackState,
	SpotifyTrack
} from "../shared/spotify";

const PLACEHOLDER_IMAGE = "imgs/actions/spotify/key";
const NULL_TRACK_HOLD_MS = 2_000;
const ARTWORK_WAIT_MS = 1_500;

@action({ UUID: "dev.aryapaw.quickbits.spotify-now-playing" })
export class SpotifyNowPlayingAction extends SingletonAction {
	private currentAction: WillAppearEvent["action"] | null = null;
	private unsubscribe: (() => void) | null = null;
	private lastTrackKey: string | null = null;
	private cachedImageKey: string | null = null;
	private lastHadTrackAt = 0;
	private artworkWaitUntil = 0;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		this.unsubscribe = spotifyState.subscribe((state) => this.onStateChange(state));
	}

	override async onWillDisappear(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const { track } = spotifyState.getState();
		if (!track) {
			await ev.action.showAlert();
			return;
		}

		const previousPlaying = track.isPlaying;
		const nextPlaying = !previousPlaying;
		spotifyState.setPlayingOptimistic(nextPlaying);
		await this.render(track, nextPlaying);

		const success = await spotifyLocalClient.togglePlayPause();
		if (!success) {
			spotifyState.setPlayingOptimistic(previousPlaying);
			await this.render(track, previousPlaying);
			await ev.action.showAlert();
		}
	}

	private trackKey(track: SpotifyTrack): string {
		return `${track.id}:${track.name}:${track.artist}`;
	}

	private imageKey(track: SpotifyTrack, isPlaying: boolean): string {
		const artSlice = track.albumArtBase64?.slice(0, 32) ?? "";
		return `${track.id}:${track.albumArtPath ?? ""}:${artSlice}:${isPlaying}`;
	}

	private hasArtwork(track: SpotifyTrack): boolean {
		return !!(track.albumArtPath || track.albumArtBase64);
	}

	private async onStateChange(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;

		const { track } = state;
		if (!track) {
			if (Date.now() - this.lastHadTrackAt < NULL_TRACK_HOLD_MS && this.cachedImageKey) {
				await this.currentAction.setTitle("");
				return;
			}

			this.lastTrackKey = null;
			this.cachedImageKey = null;
			this.artworkWaitUntil = 0;
			await this.currentAction.setTitle("");
			await this.currentAction.setImage(PLACEHOLDER_IMAGE);
			return;
		}

		this.lastHadTrackAt = Date.now();
		await this.currentAction.setTitle("");

		const nextTrackKey = this.trackKey(track);
		if (this.lastTrackKey !== nextTrackKey) {
			this.lastTrackKey = nextTrackKey;
			this.cachedImageKey = null;
			this.artworkWaitUntil = this.hasArtwork(track) ? 0 : Date.now() + ARTWORK_WAIT_MS;
		}

		await this.render(track, track.isPlaying);
	}

	private async render(track: SpotifyTrack, isPlaying: boolean): Promise<void> {
		if (!this.currentAction) return;

		const nextImageKey = this.imageKey(track, isPlaying);
		if (this.cachedImageKey === nextImageKey) {
			return;
		}

		if (!this.hasArtwork(track)) {
			if (Date.now() < this.artworkWaitUntil) {
				return;
			}
			this.cachedImageKey = nextImageKey;
			await this.currentAction.setImage(PLACEHOLDER_IMAGE);
			return;
		}

		const image = buildNowPlayingKeyImage(track, isPlaying);
		if (!image) {
			if (Date.now() < this.artworkWaitUntil) {
				return;
			}
			this.cachedImageKey = nextImageKey;
			await this.currentAction.setImage(PLACEHOLDER_IMAGE);
			return;
		}

		this.cachedImageKey = nextImageKey;
		await this.currentAction.setImage(image);
	}
}
