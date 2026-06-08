import { exec } from "node:child_process";
import { promisify } from "node:util";
import streamDeck from "@elgato/streamdeck";
import { saveSpotifySettings } from "./settings";
import type { SpotifySettings } from "./types";

const execAsync = promisify(exec);

export const REDIRECT_URI = "http://127.0.0.1:5789/callback";
export const SCOPES = [
	"user-read-playback-state",
	"user-modify-playback-state",
	"user-library-read",
	"user-library-modify"
].join(" ");

type SetupCallback = (clientId: string, clientSecret: string, appName?: string) => Promise<void>;

class SpotifyAuth {
	private pendingSettings: SpotifySettings | null = null;
	private settingsCallback: ((settings: SpotifySettings) => void) | null = null;
	private refreshInFlight: Promise<boolean> | null = null;
	private setupSubmitCallback: SetupCallback | null = null;

	setPendingOAuthSettings(settings: SpotifySettings): void {
		this.pendingSettings = settings;
	}

	async runSetupSubmitCallback(
		clientId: string,
		clientSecret: string,
		appName?: string
	): Promise<void> {
		await this.setupSubmitCallback?.(clientId, clientSecret, appName);
	}

	async finishOAuthCallback(code: string): Promise<SpotifySettings | null> {
		if (!this.pendingSettings) {
			return null;
		}
		const result = await this.exchangeCodeForToken(this.pendingSettings, code);
		this.pendingSettings = null;
		return result.refreshToken ? result : null;
	}

	notifySettingsReceived(settings: SpotifySettings): void {
		this.settingsCallback?.(settings);
	}

	async startSetupServer(onCredentialsSubmit: SetupCallback): Promise<void> {
		this.setupSubmitCallback = onCredentialsSubmit;
	}

	async openSetupPage(): Promise<boolean> {
		try {
			await execAsync(`start "" "http://127.0.0.1:5789/"`);
			return true;
		} catch {
			return false;
		}
	}

	onSettingsReceived(callback: (settings: SpotifySettings) => void): void {
		this.settingsCallback = callback;
	}

	private async exchangeCodeForToken(settings: SpotifySettings, code: string): Promise<SpotifySettings> {
		try {
			streamDeck.logger.info(`[Spotify] Exchanging code, clientId: ${settings.clientId?.substring(0, 8)}...`);
			const response = await fetch("https://accounts.spotify.com/api/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"Authorization": "Basic " + Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")
				},
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: REDIRECT_URI
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				streamDeck.logger.error(`[Spotify] Token exchange failed: ${response.status} ${errorText}`);
				return settings;
			}

			const data = await response.json() as {
				access_token: string;
				refresh_token: string;
				expires_in: number;
			};

			return {
				...settings,
				accessToken: data.access_token,
				refreshToken: data.refresh_token,
				tokenExpiry: Date.now() + data.expires_in * 1000
			};
		} catch {
			return settings;
		}
	}

	async refreshAccessToken(settings: SpotifySettings): Promise<boolean> {
		if (this.refreshInFlight) {
			return this.refreshInFlight;
		}

		this.refreshInFlight = this.doRefreshAccessToken(settings).finally(() => {
			this.refreshInFlight = null;
		});
		return this.refreshInFlight;
	}

	private async doRefreshAccessToken(settings: SpotifySettings): Promise<boolean> {
		if (!settings.refreshToken || !settings.clientId || !settings.clientSecret) {
			return false;
		}

		try {
			const response = await fetch("https://accounts.spotify.com/api/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"Authorization": "Basic " + Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")
				},
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: settings.refreshToken
				})
			});

			if (!response.ok) return false;

			const data = await response.json() as {
				access_token: string;
				expires_in: number;
				refresh_token?: string;
			};

			settings.accessToken = data.access_token;
			settings.tokenExpiry = Date.now() + data.expires_in * 1000;
			if (data.refresh_token) {
				settings.refreshToken = data.refresh_token;
			}
			await saveSpotifySettings(settings);
			return true;
		} catch {
			return false;
		}
	}

	async ensureAccessToken(settings: SpotifySettings, forceRefresh = false): Promise<string | null> {
		const needRefresh =
			forceRefresh ||
			!settings.accessToken ||
			!settings.tokenExpiry ||
			Date.now() >= settings.tokenExpiry - 60000;
		if (needRefresh) {
			const success = await this.refreshAccessToken(settings);
			if (!success) return null;
		}
		return settings.accessToken || null;
	}
}

export const spotifyAuth = new SpotifyAuth();
