import streamDeck, {
	action,
	KeyDownEvent,
	PropertyInspectorDidAppearEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { spotifyAuth, loadSpotifySettings, saveSpotifySettings, spotifyWebServer, spotifyAPI } from "../shared/spotify";

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
			this.sendConnectionStatus(true, undefined, newSettings.accountDisplayName);
		});
	}

	override onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent): void {
		void this.refreshConnectionStatus();
	}

	private async refreshConnectionStatus(): Promise<void> {
		const settings = await loadSpotifySettings();
		const connected = !!settings.refreshToken;
		let displayName = settings.accountDisplayName;

		if (connected && !displayName) {
			const profile = await spotifyAPI.fetchUserProfile(settings);
			if (profile?.display_name) {
				displayName = profile.display_name;
				await saveSpotifySettings({ ...settings, accountDisplayName: profile.display_name });
			}
		}

		this.sendConnectionStatus(
			connected,
			connected ? undefined : "Not connected",
			displayName
		);
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

		spotifyWebServer.ensure();
		await spotifyAuth.startSetupServer(async (id, secret, appName) => {
			await saveSpotifySettings({
				clientId: id,
				clientSecret: secret,
				...(appName ? { appName } : {})
			});
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
		spotifyWebServer.ensure();
		await spotifyAuth.startSetupServer(async (clientId, clientSecret, appName) => {
			await saveSpotifySettings({
				clientId,
				clientSecret,
				...(appName ? { appName } : {})
			});
		});

		const opened = await spotifyAuth.openSetupPage();
		if (!opened) {
			await ev.action.showAlert();
		}
	}

	private sendConnectionStatus(connected: boolean, message?: string, displayName?: string): void {
		const defaultMessage = connected
			? displayName
				? `Connected as ${displayName}`
				: "Connected to Spotify!"
			: "Not connected";
		streamDeck.ui.sendToPropertyInspector({
			status: connected ? "connected" : "disconnected",
			message: message ?? defaultMessage,
			displayName: displayName ?? ""
		});
	}
}
