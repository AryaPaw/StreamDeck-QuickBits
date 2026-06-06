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

		if (!settings.refreshToken) {
			await ev.action.showAlert();
			return;
		}

		const { track, isLiked } = spotifyState.getState();
		if (!track) {
			await ev.action.showAlert();
			return;
		}

		const newLiked = !isLiked;
		spotifyState.setLikedOptimistic(newLiked);

		const success = await spotifyAPI.setLike(settings, track, newLiked);
		if (!success) {
			spotifyState.setLikedOptimistic(isLiked);
			await ev.action.showAlert();
			return;
		}

		await ev.action.setTitle("");
		await this.setLikeImage(ev.action, newLiked);
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
