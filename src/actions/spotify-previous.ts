import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { spotifyLocalClient } from "../shared/spotify";

@action({ UUID: "dev.aryapaw.quickbits.spotify-previous" })
export class SpotifyPreviousAction extends SingletonAction {
	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		await ev.action.setTitle("");
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const success = await spotifyLocalClient.previous();
		if (!success) {
			await ev.action.showAlert();
		}
	}
}
