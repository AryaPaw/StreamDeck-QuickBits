import streamDeck, {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { KeyPressGuard } from "../shared/key-press-guard";
import {
	spotifyAPI,
	getSpotifySettings,
	loadSpotifySettings,
	spotifyState,
	SpotifyPlaybackState
} from "../shared/spotify";
import { spotifyApiGateway } from "../shared/spotify/api-gateway";

const LIKE_IMAGE = "imgs/actions/spotify/like";
const LIKED_IMAGE = "imgs/actions/spotify/liked";
const LIKE_PENDING_IMAGE = "imgs/actions/spotify/like-pending";
const LIKE_API_UNAVAILABLE_IMAGE = "imgs/actions/spotify/like-api-unavailable";

@action({ UUID: "dev.aryapaw.quickbits.spotify-like" })
export class SpotifyLikeAction extends SingletonAction {
	private readonly keyPressGuard = new KeyPressGuard();
	private currentAction: WillAppearEvent["action"] | null = null;
	private unsubscribe: (() => void) | null = null;
	private renderSerial = 0;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		await loadSpotifySettings();
		this.unsubscribe = spotifyState.subscribe((state) => this.onStateChange(state));
		await spotifyState.registerLikeSync();
		await this.renderLikeKey(spotifyState.getState());
	}

	override async onWillDisappear(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		spotifyState.unregisterLikeSync();
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		await this.keyPressGuard.run(ev.action.id, async () => {
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
			spotifyState.beginLikeToggle(newLiked);

			const success = await spotifyAPI.setLike(settings, track, newLiked);
			const stillSameTrack = spotifyState.getState().track?.id === track.id;
			if (!success) {
				if (stillSameTrack) {
					spotifyState.cancelLikeToggle();
					if (spotifyApiGateway.getLastError() === "geo_blocked") {
						spotifyState.markGeoBlocked();
						streamDeck.logger.warn(
							`[Spotify] Like blocked by geo/VPN - fix network exit country, then retry`
						);
					} else {
						spotifyState.markLikeUnavailable();
					}
				}
				await ev.action.showAlert();
				return;
			}

			if (stillSameTrack) {
				spotifyState.confirmLike(newLiked);
			}
			await this.renderLikeKey(spotifyState.getState());
		});
	}

	private async onStateChange(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;
		await this.renderLikeKey(state);
	}

	private async renderLikeKey(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;

		const serial = ++this.renderSerial;
		await this.currentAction.setTitle("");

		if (serial !== this.renderSerial) {
			return;
		}

		if (
			state.likeApiStatus === "no_auth" ||
			state.likeApiStatus === "geo_blocked" ||
			(!state.likeKnown &&
				!state.likePending &&
				(state.likeApiStatus === "unavailable" || state.likeApiStatus === "rate_limited"))
		) {
			await this.currentAction.setImage(LIKE_API_UNAVAILABLE_IMAGE);
			return;
		}

		if (state.likePending) {
			await this.currentAction.setImage(LIKE_PENDING_IMAGE);
			return;
		}

		await this.currentAction.setImage(state.isLiked ? LIKED_IMAGE : LIKE_IMAGE);
	}
}
