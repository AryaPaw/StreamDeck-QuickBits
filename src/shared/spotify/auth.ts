import { exec } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

type SetupCallback = (clientId: string, clientSecret: string) => Promise<void>;

class SpotifyAuth {
	private server: ReturnType<typeof createServer> | null = null;
	private pendingSettings: SpotifySettings | null = null;
	private settingsCallback: ((settings: SpotifySettings) => void) | null = null;
	private refreshInFlight: Promise<boolean> | null = null;

	async startSetupServer(onCredentialsSubmit: SetupCallback): Promise<void> {
		if (this.server) {
			this.server.close();
		}

		const currentDir = dirname(fileURLToPath(import.meta.url));
		const webDir = join(currentDir, "..", "web");

		this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url || "/", "http://127.0.0.1:5789");

			if (url.pathname === "/" || url.pathname === "/setup") {
				try {
					const html = await readFile(join(webDir, "setup.html"), "utf-8");
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(html);
				} catch {
					res.writeHead(500, { "Content-Type": "text/plain" });
					res.end("Error loading setup page");
				}
				return;
			}

			if (url.pathname === "/submit" && req.method === "POST") {
				let body = "";
				req.on("data", (chunk: Buffer) => body += chunk.toString());
				req.on("end", async () => {
					try {
						const { clientId, clientSecret } = JSON.parse(body);

						if (!clientId || !clientSecret) {
							res.writeHead(400, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ success: false, error: "Missing credentials" }));
							return;
						}

						this.pendingSettings = { clientId, clientSecret };
						await onCredentialsSubmit(clientId, clientSecret);

						const authUrl = new URL("https://accounts.spotify.com/authorize");
						authUrl.searchParams.set("client_id", clientId);
						authUrl.searchParams.set("response_type", "code");
						authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
						authUrl.searchParams.set("scope", SCOPES);

						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ success: true, authUrl: authUrl.toString() }));
					} catch {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ success: false, error: "Invalid request" }));
					}
				});
				return;
			}

			if (url.pathname === "/callback") {
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				if (code && this.pendingSettings) {
					streamDeck.logger.info("[Spotify] Exchanging code for token...");
					const newSettings = await this.exchangeCodeForToken(this.pendingSettings, code);
					streamDeck.logger.info(
						`[Spotify] Token exchange result: ${newSettings.refreshToken ? "success" : "failed"}`
					);

					if (newSettings.refreshToken) {
						this.settingsCallback?.(newSettings);
						res.writeHead(302, { "Location": "/?success=true" });
						res.end();
					} else {
						res.writeHead(302, { "Location": "/?error=token_failed" });
						res.end();
					}
				} else {
					res.writeHead(302, { "Location": `/?error=${encodeURIComponent(error || "auth_failed")}` });
					res.end();
				}

				setTimeout(() => {
					this.server?.close();
					this.server = null;
					this.pendingSettings = null;
				}, 2000);
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		});

		this.server.listen(5789);
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

	stopServer(): void {
		this.server?.close();
		this.server = null;
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
