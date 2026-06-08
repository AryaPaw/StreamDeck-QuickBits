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
const LIKE_API_UNAVAILABLE_IMAGE = "imgs/actions/spotify/like-api-unavailable";

@action({ UUID: "dev.aryapaw.quickbits.spotify-like" })
export class SpotifyLikeAction extends SingletonAction {
	private currentAction: WillAppearEvent["action"] | null = null;
	private unsubscribe: (() => void) | null = null;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		await loadSpotifySettings();
		spotifyState.registerLikeSync();
		this.unsubscribe = spotifyState.subscribe((state) => this.onStateChange(state));
	}

	override async onWillDisappear(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		spotifyState.unregisterLikeSync();
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		await loadSpotifySettings();
		const settings = getSpotifySettings();
		const state = spotifyState.getState();

		if (!settings.refreshToken || state.likeApiStatus === "no_auth") {
			await ev.action.showAlert();
			return;
		}

		const { track, isLiked } = state;
		if (!track) {
			await ev.action.showAlert();
			return;
		}

		const newLiked = !isLiked;
		spotifyState.setLikedOptimistic(newLiked);

		const success = await spotifyAPI.setLike(settings, track, newLiked);
		if (!success) {
			spotifyState.setLikedOptimistic(isLiked);
			spotifyState.refreshLikeApiStatus();
			await ev.action.showAlert();
			return;
		}

		await this.renderLikeKey(spotifyState.getState());
	}

	private async onStateChange(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;
		await this.renderLikeKey(state);
	}

	private async renderLikeKey(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;

		await this.currentAction.setTitle("");

		if (state.likeApiStatus === "no_auth") {
			await this.currentAction.setImage(LIKE_API_UNAVAILABLE_IMAGE);
			return;
		}

		await this.currentAction.setImage(state.isLiked ? LIKED_IMAGE : LIKE_IMAGE);
	}
}
