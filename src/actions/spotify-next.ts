import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { spotifyLocalClient } from "../shared/spotify";

@action({ UUID: "dev.aryapaw.quickbits.spotify-next" })
export class SpotifyNextAction extends SingletonAction {
	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		await ev.action.setTitle("");
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const success = await spotifyLocalClient.next();
		if (!success) {
			await ev.action.showAlert();
		}
	}
}
