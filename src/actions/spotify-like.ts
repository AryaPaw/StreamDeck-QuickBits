import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import {
	spotifyAPI,
	getSpotifySettings,
	loadSpotifySettings,
	spotifyState,
	SpotifyPlaybackState
} from "../shared/spotify";

const LIKE_IMAGE = "imgs/actions/spotify/like";
const LIKED_IMAGE = "imgs/actions/spotify/liked";

@action({ UUID: "dev.aryapaw.quickbits.spotify-like" })
export class SpotifyLikeAction extends SingletonAction {
	private currentAction: WillAppearEvent["action"] | null = null;
	private unsubscribe: (() => void) | null = null;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		await loadSpotifySettings();
		await ev.action.setTitle("");
		this.unsubscribe = spotifyState.subscribe((state) => this.onStateChange(state));
	}

	override async onWillDisappear(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		await loadSpotifySettings();
		const settings = getSpotifySettings();
		const result = await spotifyAPI.toggleLike(settings);

		if (result.success) {
			await ev.action.setTitle("");
			await this.setLikeImage(ev.action, result.isLiked);
			await spotifyState.refreshLikedStatus();
			return;
		}
		await ev.action.showAlert();
	}

	private async onStateChange(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;
		await this.currentAction.setTitle("");
		await this.setLikeImage(this.currentAction, state.isLiked);
	}

	private async setLikeImage(action: WillAppearEvent["action"], isLiked: boolean): Promise<void> {
		await action.setImage(isLiked ? LIKED_IMAGE : LIKE_IMAGE);
	}
}
