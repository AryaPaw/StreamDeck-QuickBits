import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { spotifyAPI, getSpotifySettings, loadSpotifySettings, spotifyState, SpotifyPlaybackState } from "../shared/spotify";

// Heart outline (not liked)
const LIKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="16" fill="#1a1a1a"/>
  <path d="M72 108c-1.5 0-3-.6-4-1.5C57 96.5 40 80 40 62c0-12 9.5-22 22-22 7 0 13.5 3.5 17 9 3.5-5.5 10-9 17-9 12.5 0 22 10 22 22 0 18-17 34.5-28 44.5-1 .9-2.5 1.5-4 1.5z" fill="none" stroke="#fff" stroke-width="5"/>
</svg>`;

// Heart filled (liked) - green
const LIKED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="16" fill="#1a1a1a"/>
  <path d="M72 108c-1.5 0-3-.6-4-1.5C57 96.5 40 80 40 62c0-12 9.5-22 22-22 7 0 13.5 3.5 17 9 3.5-5.5 10-9 17-9 12.5 0 22 10 22 22 0 18-17 34.5-28 44.5-1 .9-2.5 1.5-4 1.5z" fill="#1DB954"/>
</svg>`;

@action({ UUID: "dev.aryapaw.quickbits.spotify-like" })
export class SpotifyLikeAction extends SingletonAction {
	private currentAction: WillAppearEvent["action"] | null = null;
	private unsubscribe: (() => void) | null = null;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		await loadSpotifySettings();
		await ev.action.setTitle("");

		// Subscribe to centralized state
		this.unsubscribe = spotifyState.subscribe((state) => this.onStateChange(state));
	}

	override async onWillDisappear(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const settings = getSpotifySettings();
		const result = await spotifyAPI.toggleLike(settings);

		if (result.success) {
			await ev.action.setTitle("");
			await this.setLikeImage(ev.action, result.isLiked);
			// Refresh state after toggle
			spotifyState.refreshLikedStatus();
		} else {
			await ev.action.showAlert();
		}
	}

	private async onStateChange(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;
		await this.currentAction.setTitle("");
		await this.setLikeImage(this.currentAction, state.isLiked);
	}

	private async setLikeImage(action: WillAppearEvent["action"], isLiked: boolean): Promise<void> {
		const svg = isLiked ? LIKED_SVG : LIKE_SVG;
		const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
		await action.setImage(dataUri);
	}
}
