import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { spotifyAPI, loadSpotifySettings, getSpotifySettings, spotifyState, SpotifyPlaybackState } from "../shared/spotify";

// Play icon SVG overlay (shown when paused)
const PLAY_OVERLAY = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <circle cx="72" cy="72" r="26" fill="rgba(0,0,0,0.6)"/>
  <path d="M66 60l20 12-20 12V60z" fill="#fff"/>
</svg>`;

@action({ UUID: "dev.aryapaw.quickbits.spotify-now-playing" })
export class SpotifyNowPlayingAction extends SingletonAction {
	private currentAction: WillAppearEvent["action"] | null = null;
	private unsubscribe: (() => void) | null = null;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		await loadSpotifySettings();

		// Subscribe to centralized state
		this.unsubscribe = spotifyState.subscribe((state) => this.onStateChange(state));
	}

	override async onWillDisappear(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const settings = getSpotifySettings();
		await spotifyAPI.playPause(settings);
	}

	private async onStateChange(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;

		const { track } = state;

		if (!track) {
			await this.currentAction.setTitle("");
			await this.currentAction.setImage(undefined);
			return;
		}

		await this.currentAction.setTitle("");

		if (track.albumArt) {
			try {
				const overlayImage = await this.createOverlayImage(track.albumArt, track.isPlaying);
				await this.currentAction.setImage(overlayImage);
			} catch {
				await this.currentAction.setImage(undefined);
			}
		}
	}

	private async createOverlayImage(albumArtUrl: string, isPlaying: boolean): Promise<string> {
		// Fetch album art and convert to base64
		const response = await fetch(albumArtUrl);
		const arrayBuffer = await response.arrayBuffer();
		const base64Album = Buffer.from(arrayBuffer).toString("base64");
		const mimeType = response.headers.get("content-type") || "image/jpeg";

		// Show play overlay only when paused, no overlay when playing
		const overlayPart = isPlaying ? "" :
			`<image xlink:href="data:image/svg+xml;base64,${Buffer.from(PLAY_OVERLAY).toString("base64")}" width="144" height="144"/>`;

		const compositeSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144" viewBox="0 0 144 144">
			<defs>
				<clipPath id="rounded">
					<rect width="144" height="144" rx="12"/>
				</clipPath>
			</defs>
			<image xlink:href="data:${mimeType};base64,${base64Album}" width="144" height="144" clip-path="url(#rounded)"/>
			${overlayPart}
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(compositeSvg).toString("base64")}`;
	}
}
