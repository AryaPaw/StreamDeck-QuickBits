import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { spotifyAuth, loadSpotifySettings, saveSpotifySettings, getSpotifySettings } from "../shared/spotify";

@action({ UUID: "dev.aryapaw.quickbits.spotify-setup" })
export class SpotifySetupAction extends SingletonAction {
	private currentAction: WillAppearEvent["action"] | null = null;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		const settings = await loadSpotifySettings();
		await ev.action.setTitle(settings.refreshToken ? "✓" : "Setup");

		// Setup callback for when settings are received from web form
		spotifyAuth.onSettingsReceived(async (newSettings) => {
			await saveSpotifySettings(newSettings);
			if (this.currentAction) {
				await this.currentAction.setTitle("✓");
			}
		});
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		this.currentAction = ev.action;
		// Always start setup - allows re-authorization with new scopes
		await this.startSetup(ev);
	}

	private async startSetup(ev: KeyDownEvent): Promise<void> {
		// Setup callback for saving credentials
		await spotifyAuth.startSetupServer(async (clientId, clientSecret) => {
			await saveSpotifySettings({ clientId, clientSecret });
		});

		// Setup callback for when auth completes
		spotifyAuth.onSettingsReceived(async (newSettings) => {
			await saveSpotifySettings(newSettings);
			await ev.action.setTitle("✓");
		});

		// Open the setup page in browser
		const opened = await spotifyAuth.openSetupPage();
		if (!opened) {
			await ev.action.showAlert();
		}
	}
}
