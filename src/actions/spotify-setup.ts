import streamDeck, {
	action,
	KeyDownEvent,
	PropertyInspectorDidAppearEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { spotifyAuth, loadSpotifySettings, saveSpotifySettings, getSpotifySettings } from "../shared/spotify";

type SpotifySetupActionSettings = {
	clientId?: string;
	clientSecret?: string;
};

type SpotifySetupPiMessage = {
	event?: string;
};

@action({ UUID: "dev.aryapaw.quickbits.spotify-setup" })
export class SpotifySetupAction extends SingletonAction<SpotifySetupActionSettings> {
	private currentAction: WillAppearEvent["action"] | null = null;

	override async onWillAppear(ev: WillAppearEvent<SpotifySetupActionSettings>): Promise<void> {
		this.currentAction = ev.action;
		const settings = await loadSpotifySettings();
		await ev.action.setTitle(settings.refreshToken ? "✓" : "Setup");

		spotifyAuth.onSettingsReceived(async (newSettings) => {
			await saveSpotifySettings(newSettings);
			if (this.currentAction) {
				await this.currentAction.setTitle("✓");
			}
			this.sendConnectionStatus(true);
		});
	}

	override onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent): void {
		const settings = getSpotifySettings();
		this.sendConnectionStatus(!!settings.refreshToken);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<SpotifySetupPiMessage, SpotifySetupActionSettings>): Promise<void> {
		if (ev.payload.event !== "authorize") return;

		const actionSettings = await ev.action.getSettings<SpotifySetupActionSettings>();
		const clientId = actionSettings.clientId?.trim();
		const clientSecret = actionSettings.clientSecret?.trim();

		if (!clientId || !clientSecret) {
			this.sendConnectionStatus(false, "Enter Client ID and Client Secret first");
			return;
		}

		await saveSpotifySettings({ clientId, clientSecret });
		this.sendConnectionStatus(false, "Opening browser...");

		await spotifyAuth.startSetupServer(async (id, secret) => {
			await saveSpotifySettings({ clientId: id, clientSecret: secret });
		});

		const opened = await spotifyAuth.openSetupPage();
		if (!opened) {
			this.sendConnectionStatus(false, "Failed to open browser");
			await ev.action.showAlert();
		}
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

	private sendConnectionStatus(connected: boolean, message?: string): void {
		streamDeck.ui.sendToPropertyInspector({
			status: connected ? "connected" : "disconnected",
			message: message ?? (connected ? "Connected to Spotify!" : "Not connected")
		});
	}
}
