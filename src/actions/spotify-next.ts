import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { spotifyAPI, getSpotifySettings } from "../shared/spotify";

@action({ UUID: "dev.aryapaw.quickbits.spotify-next" })
export class SpotifyNextAction extends SingletonAction {
	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		await ev.action.setTitle("");
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const settings = getSpotifySettings();
		const success = await spotifyAPI.nextTrack(settings);

		if (!success) {
			await ev.action.showAlert();
		}
	}
}
