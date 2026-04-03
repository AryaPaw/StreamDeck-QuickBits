import { exec } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import streamDeck from "@elgato/streamdeck";

const execAsync = promisify(exec);

export type SpotifySettings = {
	clientId?: string;
	clientSecret?: string;
	refreshToken?: string;
	accessToken?: string;
	tokenExpiry?: number;
};

// Global settings storage for Spotify credentials
let globalSpotifySettings: SpotifySettings = {};

export async function loadSpotifySettings(): Promise<SpotifySettings> {
	const settings = await streamDeck.settings.getGlobalSettings<SpotifySettings>();
	globalSpotifySettings = settings || {};
	return globalSpotifySettings;
}

export async function saveSpotifySettings(settings: SpotifySettings): Promise<void> {
	globalSpotifySettings = { ...globalSpotifySettings, ...settings };
	await streamDeck.settings.setGlobalSettings(globalSpotifySettings);
}

export function getSpotifySettings(): SpotifySettings {
	return globalSpotifySettings;
}

const REDIRECT_URI = "http://127.0.0.1:5789/callback";
const SCOPES = [
	"user-read-playback-state",
	"user-modify-playback-state",
	"user-read-currently-playing",
	"user-library-read",
	"user-library-modify"
].join(" ");

type SetupCallback = (clientId: string, clientSecret: string) => Promise<void>;

class SpotifyAuth {
	private server: ReturnType<typeof createServer> | null = null;
	private authCode: string | null = null;
	private pendingSettings: SpotifySettings | null = null;
	private settingsCallback: ((settings: SpotifySettings) => void) | null = null;

	async startSetupServer(onCredentialsSubmit: SetupCallback): Promise<void> {
		if (this.server) {
			this.server.close();
		}

		const currentDir = dirname(fileURLToPath(import.meta.url));
		const webDir = join(currentDir, "..", "web");

		this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url || "/", "http://127.0.0.1:5789");

			// Serve setup page
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

			// Handle form submission
			if (url.pathname === "/submit" && req.method === "POST") {
				let body = "";
				req.on("data", chunk => body += chunk);
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
					} catch (err) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ success: false, error: "Invalid request" }));
					}
				});
				return;
			}

			// Handle OAuth callback
			if (url.pathname === "/callback") {
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				if (code && this.pendingSettings) {
					this.authCode = code;
					console.log("[Spotify] Exchanging code for token...");
					const newSettings = await this.exchangeCodeForToken(this.pendingSettings, code);
					console.log("[Spotify] Token exchange result:", newSettings.refreshToken ? "success" : "failed");

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

	async startAuthFlow(settings: SpotifySettings): Promise<boolean> {
		if (!settings.clientId) return false;

		const authUrl = new URL("https://accounts.spotify.com/authorize");
		authUrl.searchParams.set("client_id", settings.clientId);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
		authUrl.searchParams.set("scope", SCOPES);

		try {
			await execAsync(`start "" "${authUrl.toString()}"`);
			return true;
		} catch {
			return false;
		}
	}

	async waitForCallback(settings: SpotifySettings): Promise<SpotifySettings> {
		return new Promise((resolve) => {
			this.authCode = null;

			this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
				const url = new URL(req.url || "/", `http://127.0.0.1:5789`);

				if (url.pathname === "/callback") {
					const code = url.searchParams.get("code");
					const error = url.searchParams.get("error");

					if (code) {
						this.authCode = code;
						res.writeHead(200, { "Content-Type": "text/html" });
						res.end(`
							<html>
							<body style="background:#1a1a2e;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
								<div style="text-align:center">
									<h1 style="color:#1DB954">✓ Connected to Spotify!</h1>
									<p>You can close this window.</p>
								</div>
							</body>
							</html>
						`);
					} else {
						res.writeHead(400, { "Content-Type": "text/html" });
						res.end(`
							<html>
							<body style="background:#1a1a2e;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
								<div style="text-align:center">
									<h1 style="color:#ff5252">✗ Authorization Failed</h1>
									<p>${error || "Unknown error"}</p>
								</div>
							</body>
							</html>
						`);
					}

					setTimeout(() => {
						this.server?.close();
						this.server = null;
					}, 1000);
				}
			});

			this.server.listen(5789);

			const timeout = setTimeout(() => {
				this.server?.close();
				this.server = null;
				resolve(settings);
			}, 120000);

			const checkInterval = setInterval(async () => {
				if (this.authCode) {
					clearInterval(checkInterval);
					clearTimeout(timeout);

					const newSettings = await this.exchangeCodeForToken(settings, this.authCode);
					resolve(newSettings);
				}
			}, 500);
		});
	}

	private async exchangeCodeForToken(settings: SpotifySettings, code: string): Promise<SpotifySettings> {
		try {
			console.log("[Spotify] Exchanging code, clientId:", settings.clientId?.substring(0, 8) + "...");
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
				console.log("[Spotify] Token exchange failed:", response.status, errorText);
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
			};

			settings.accessToken = data.access_token;
			settings.tokenExpiry = Date.now() + data.expires_in * 1000;
			return true;
		} catch {
			return false;
		}
	}

	async ensureAccessToken(settings: SpotifySettings): Promise<string | null> {
		if (!settings.accessToken || !settings.tokenExpiry || Date.now() >= settings.tokenExpiry - 60000) {
			const success = await this.refreshAccessToken(settings);
			if (!success) return null;
		}
		return settings.accessToken || null;
	}
}

export const spotifyAuth = new SpotifyAuth();

export class SpotifyAPI {
	async getCurrentTrack(settings: SpotifySettings): Promise<SpotifyTrack | null> {
		const token = await spotifyAuth.ensureAccessToken(settings);
		if (!token) return null;

		try {
			const response = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
				headers: { "Authorization": `Bearer ${token}` }
			});

			if (response.status === 204) return null;
			if (!response.ok) return null;

			const data = await response.json() as SpotifyCurrentlyPlaying;
			if (!data.item) return null;

			return {
				id: data.item.id,
				uri: data.item.uri,
				name: data.item.name,
				artist: data.item.artists.map(a => a.name).join(", "),
				album: data.item.album.name,
				albumArt: data.item.album.images[0]?.url,
				isPlaying: data.is_playing,
				progress: data.progress_ms,
				duration: data.item.duration_ms
			};
		} catch {
			return null;
		}
	}

	async isTrackSaved(settings: SpotifySettings, trackUri: string): Promise<boolean> {
		const token = await spotifyAuth.ensureAccessToken(settings);
		if (!token) {
			streamDeck.logger.error("[Spotify] isTrackSaved: no token");
			return false;
		}

		try {
			const response = await fetch(`https://api.spotify.com/v1/me/library/contains?uris=${encodeURIComponent(trackUri)}`, {
				headers: { "Authorization": `Bearer ${token}` }
			});

			if (!response.ok) {
				streamDeck.logger.error("[Spotify] isTrackSaved failed: " + response.status);
				return false;
			}
			const data = await response.json() as boolean[];
			return data[0] || false;
		} catch (e) {
			streamDeck.logger.error("[Spotify] isTrackSaved error: " + e);
			return false;
		}
	}

	async saveTrack(settings: SpotifySettings, trackUri: string): Promise<boolean> {
		const token = await spotifyAuth.ensureAccessToken(settings);
		if (!token) {
			streamDeck.logger.error("[Spotify] saveTrack: no token");
			return false;
		}

		try {
			const response = await fetch(`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(trackUri)}`, {
				method: "PUT",
				headers: { "Authorization": `Bearer ${token}` }
			});
			if (!response.ok) {
				streamDeck.logger.error("[Spotify] saveTrack failed: " + response.status + " " + await response.text());
			}
			return response.ok;
		} catch (e) {
			streamDeck.logger.error("[Spotify] saveTrack error: " + e);
			return false;
		}
	}

	async removeTrack(settings: SpotifySettings, trackUri: string): Promise<boolean> {
		const token = await spotifyAuth.ensureAccessToken(settings);
		if (!token) {
			streamDeck.logger.error("[Spotify] removeTrack: no token");
			return false;
		}

		try {
			const response = await fetch(`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(trackUri)}`, {
				method: "DELETE",
				headers: { "Authorization": `Bearer ${token}` }
			});
			if (!response.ok) {
				streamDeck.logger.error("[Spotify] removeTrack failed: " + response.status + " " + await response.text());
			}
			return response.ok;
		} catch (e) {
			streamDeck.logger.error("[Spotify] removeTrack error: " + e);
			return false;
		}
	}

	async toggleLike(settings: SpotifySettings): Promise<{ success: boolean; isLiked: boolean }> {
		const track = await this.getCurrentTrack(settings);
		if (!track) {
			streamDeck.logger.error("[Spotify] toggleLike: no track");
			return { success: false, isLiked: false };
		}

		const isCurrentlyLiked = await this.isTrackSaved(settings, track.uri);

		if (isCurrentlyLiked) {
			const success = await this.removeTrack(settings, track.uri);
			return { success, isLiked: false };
		} else {
			const success = await this.saveTrack(settings, track.uri);
			return { success, isLiked: true };
		}
	}

	async playPause(settings: SpotifySettings): Promise<boolean> {
		const token = await spotifyAuth.ensureAccessToken(settings);
		if (!token) return false;

		const track = await this.getCurrentTrack(settings);
		const endpoint = track?.isPlaying
			? "https://api.spotify.com/v1/me/player/pause"
			: "https://api.spotify.com/v1/me/player/play";

		try {
			const response = await fetch(endpoint, {
				method: "PUT",
				headers: { "Authorization": `Bearer ${token}` }
			});
			return response.ok || response.status === 204;
		} catch {
			return false;
		}
	}

	async nextTrack(settings: SpotifySettings): Promise<boolean> {
		const token = await spotifyAuth.ensureAccessToken(settings);
		if (!token) return false;

		try {
			const response = await fetch("https://api.spotify.com/v1/me/player/next", {
				method: "POST",
				headers: { "Authorization": `Bearer ${token}` }
			});
			return response.ok || response.status === 204;
		} catch {
			return false;
		}
	}

	async previousTrack(settings: SpotifySettings): Promise<boolean> {
		const token = await spotifyAuth.ensureAccessToken(settings);
		if (!token) return false;

		try {
			const response = await fetch("https://api.spotify.com/v1/me/player/previous", {
				method: "POST",
				headers: { "Authorization": `Bearer ${token}` }
			});
			return response.ok || response.status === 204;
		} catch {
			return false;
		}
	}
}

export const spotifyAPI = new SpotifyAPI();

// Centralized state manager with single polling
type StateListener = (state: SpotifyPlaybackState) => void;

export type SpotifyPlaybackState = {
	track: SpotifyTrack | null;
	isLiked: boolean;
};

class SpotifyState {
	private listeners: Set<StateListener> = new Set();
	private pollInterval: NodeJS.Timeout | null = null;
	private currentState: SpotifyPlaybackState = { track: null, isLiked: false };
	private lastTrackId: string | null = null;

	start(): void {
		if (this.pollInterval) return;
		this.poll();
		this.pollInterval = setInterval(() => this.poll(), 500);
	}

	stop(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		// Send current state immediately
		if (this.currentState.track) {
			listener(this.currentState);
		}
		// Start polling if first subscriber
		if (this.listeners.size === 1) {
			this.start();
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				this.stop();
			}
		};
	}

	private emit(state: SpotifyPlaybackState): void {
		for (const listener of this.listeners) {
			listener(state);
		}
	}

	private async poll(): Promise<void> {
		const settings = getSpotifySettings();
		if (!settings.refreshToken) return;

		const track = await spotifyAPI.getCurrentTrack(settings);

		let isLiked = this.currentState.isLiked;

		// Only check liked status if track changed or first poll
		if (track && (track.id !== this.lastTrackId || this.lastTrackId === null)) {
			isLiked = await spotifyAPI.isTrackSaved(settings, track.uri);
			this.lastTrackId = track.id;
		}

		const newState: SpotifyPlaybackState = { track, isLiked };

		// Check if state changed
		const trackChanged = this.currentState.track?.id !== track?.id;
		const playingChanged = this.currentState.track?.isPlaying !== track?.isPlaying;
		const likedChanged = this.currentState.isLiked !== isLiked;

		if (trackChanged || playingChanged || likedChanged) {
			this.currentState = newState;
			this.emit(newState);
		}
	}

	async refreshLikedStatus(): Promise<void> {
		const settings = getSpotifySettings();
		if (!this.currentState.track) return;

		const isLiked = await spotifyAPI.isTrackSaved(settings, this.currentState.track.uri);
		if (isLiked !== this.currentState.isLiked) {
			this.currentState = { ...this.currentState, isLiked };
			this.emit(this.currentState);
		}
	}

	getState(): SpotifyPlaybackState {
		return this.currentState;
	}
}

export const spotifyState = new SpotifyState();

export type SpotifyTrack = {
	id: string;
	uri: string;
	name: string;
	artist: string;
	album: string;
	albumArt?: string;
	isPlaying: boolean;
	progress: number;
	duration: number;
};

type SpotifyCurrentlyPlaying = {
	is_playing: boolean;
	progress_ms: number;
	item: {
		id: string;
		uri: string;
		name: string;
		duration_ms: number;
		artists: { name: string }[];
		album: {
			name: string;
			images: { url: string }[];
		};
	} | null;
};
