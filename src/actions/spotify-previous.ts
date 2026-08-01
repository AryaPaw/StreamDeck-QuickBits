import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { KeyPressGuard } from "../shared/key-press-guard";
import { spotifyLocalClient } from "../shared/spotify";

@action({ UUID: "dev.aryapaw.quickbits.spotify-previous" })
export class SpotifyPreviousAction extends SingletonAction {
	private readonly keyPressGuard = new KeyPressGuard();
	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		await ev.action.setTitle("");
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		await this.keyPressGuard.run(ev.action.id, async () => {
			const success = await spotifyLocalClient.previous();
			if (!success) {
				await ev.action.showAlert();
			}
		});
	}
}
