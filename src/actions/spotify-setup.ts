import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { spotifyAuth, loadSpotifySettings, saveSpotifySettings } from "../shared/spotify";

@action({ UUID: "dev.aryapaw.quickbits.spotify-setup" })
export class SpotifySetupAction extends SingletonAction {
	private currentAction: WillAppearEvent["action"] | null = null;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		const settings = await loadSpotifySettings();
		await ev.action.setTitle(settings.refreshToken ? "✓" : "Setup");

		spotifyAuth.onSettingsReceived(async (newSettings) => {
			await saveSpotifySettings(newSettings);
			if (this.currentAction) {
				await this.currentAction.setTitle("✓");
			}
		});
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		this.currentAction = ev.action;
		await this.startSetup(ev);
	}

	private async startSetup(ev: KeyDownEvent): Promise<void> {
		await spotifyAuth.startSetupServer(async (clientId, clientSecret) => {
			await saveSpotifySettings({ clientId, clientSecret });
		});

		const opened = await spotifyAuth.openSetupPage();
		if (!opened) {
			await ev.action.showAlert();
		}
	}
}
