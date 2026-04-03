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

type SpotifyPlayingItem = {
	type?: string;
	id: string;
	uri: string;
	name: string;
	duration_ms: number;
	artists?: { name: string }[];
	album?: { name: string; images?: { url: string }[] };
	show?: { name: string; publisher?: string; images?: { url: string }[] };
};

function mapPlayingItemToTrack(
	item: SpotifyPlayingItem,
	isPlaying: boolean,
	progressMs: number
): SpotifyTrack | null {
	const isEpisode =
		item.type === "episode" || (typeof item.uri === "string" && item.uri.startsWith("spotify:episode:"));

	if (isEpisode) {
		const show = item.show;
		return {
			id: item.id,
			uri: item.uri,
			name: item.name,
			artist: show?.publisher || show?.name || "Podcast",
			album: show?.name || "",
			albumArt: show?.images?.[0]?.url,
			isPlaying,
			progress: progressMs,
			duration: item.duration_ms
		};
	}

	const album = item.album;
	if (!album?.name) {
		return null;
	}

	const artists = item.artists;
	return {
		id: item.id,
		uri: item.uri,
		name: item.name,
		artist: artists?.length ? artists.map((a) => a.name).join(", ") : "Unknown",
		album: album.name,
		albumArt: album.images?.[0]?.url,
		isPlaying,
		progress: progressMs,
		duration: item.duration_ms
	};
}

export class SpotifyAPI {
	private static readonly PLAYBACK_QUERY = "additional_types=track,episode";
	private last429WarnAt = 0;

	private playbackUrl(path: string): string {
		const sep = path.includes("?") ? "&" : "?";
		return `https://api.spotify.com/v1/me/player${path}${sep}${SpotifyAPI.PLAYBACK_QUERY}`;
	}

	private warn429(scope: string, response: Response): void {
		const now = Date.now();
		if (now - this.last429WarnAt < 10_000) {
			return;
		}
		this.last429WarnAt = now;
		const retryAfter = response.headers.get("Retry-After");
		streamDeck.logger.warn(
			`[Spotify] ${scope}: rate limited (429)${retryAfter ? `, Retry-After=${retryAfter}s` : ""}`
		);
	}

	private async requestWithAuth(
		settings: SpotifySettings,
		url: string,
		init?: { method?: "PUT" | "POST" | "DELETE"; headers?: Record<string, string> }
	): Promise<Response | null> {
		let token = await spotifyAuth.ensureAccessToken(settings);
		if (!token) {
			return null;
		}

		const doFetch = (authToken: string) => {
			const headers = { ...(init?.headers ?? {}), Authorization: `Bearer ${authToken}` };
			return fetch(url, { ...init, headers });
		};

		try {
			let response = await doFetch(token);
			if (response.status === 401) {
				token = await spotifyAuth.ensureAccessToken(settings, true);
				if (!token) return null;
				response = await doFetch(token);
			}
			return response;
		} catch (e) {
			streamDeck.logger.error(`[Spotify] request failed: ${url} ${e}`);
			return null;
		}
	}

	private async isSavedUri(settings: SpotifySettings, uri: string): Promise<boolean> {
		const response = await this.requestWithAuth(
			settings,
			`https://api.spotify.com/v1/me/library/contains?uris=${encodeURIComponent(uri)}`
		);
		if (!response) return false;
		if (response.status === 429) {
			this.warn429("isSaved", response);
			return false;
		}
		if (!response.ok) {
			streamDeck.logger.error(
				`[Spotify] isSaved failed: ${response.status} ${await response.text()}`
			);
			return false;
		}
		const data = (await response.json()) as boolean[];
		return data[0] || false;
	}

	private async setSavedUri(settings: SpotifySettings, uri: string, method: "PUT" | "DELETE"): Promise<boolean> {
		const response = await this.requestWithAuth(
			settings,
			`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(uri)}`,
			{ method }
		);
		if (!response) return false;
		if (response.status === 429) {
			this.warn429("setSaved", response);
			return false;
		}
		if (!response.ok) {
			streamDeck.logger.error(
				`[Spotify] ${method === "PUT" ? "save" : "remove"} failed: ${response.status} ${await response.text()}`
			);
		}
		return response.ok;
	}

	async getCurrentTrack(settings: SpotifySettings): Promise<SpotifyTrack | null> {
		const response = await this.requestWithAuth(settings, this.playbackUrl(""));
		if (!response) {
			streamDeck.logger.error("[Spotify] getCurrentTrack: no token or request failed");
			return null;
		}
		if (response.status === 429) {
			this.warn429("getCurrentTrack", response);
			return null;
		}
		if (response.status === 204) return null;
		if (!response.ok) {
			streamDeck.logger.warn(`[Spotify] getCurrentTrack failed: ${response.status}`);
			return null;
		}

		try {
			const data = (await response.json()) as SpotifyCurrentlyPlaying;
			if (!data.item) return null;
			return mapPlayingItemToTrack(data.item, data.is_playing, data.progress_ms ?? 0);
		} catch (e) {
			streamDeck.logger.error("[Spotify] getCurrentTrack parse error: " + e);
			return null;
		}
	}

	async isTrackSaved(settings: SpotifySettings, trackUri: string): Promise<boolean> {
		return this.isSavedUri(settings, trackUri);
	}

	async isEpisodeSaved(settings: SpotifySettings, episodeId: string): Promise<boolean> {
		return this.isSavedUri(settings, `spotify:episode:${episodeId}`);
	}

	async saveTrack(settings: SpotifySettings, trackUri: string): Promise<boolean> {
		return this.setSavedUri(settings, trackUri, "PUT");
	}

	async removeTrack(settings: SpotifySettings, trackUri: string): Promise<boolean> {
		return this.setSavedUri(settings, trackUri, "DELETE");
	}

	async saveEpisode(settings: SpotifySettings, episodeId: string): Promise<boolean> {
		return this.setSavedUri(settings, `spotify:episode:${episodeId}`, "PUT");
	}

	async removeEpisode(settings: SpotifySettings, episodeId: string): Promise<boolean> {
		return this.setSavedUri(settings, `spotify:episode:${episodeId}`, "DELETE");
	}

	async toggleLike(settings: SpotifySettings): Promise<{ success: boolean; isLiked: boolean }> {
		const track = await this.getCurrentTrack(settings);
		if (!track) {
			streamDeck.logger.error("[Spotify] toggleLike: no current item");
			return { success: false, isLiked: false };
		}
		if (track.uri.startsWith("spotify:local:")) {
			streamDeck.logger.warn("[Spotify] toggleLike: local files cannot be liked via API");
			return { success: false, isLiked: false };
		}

		const isEpisode = track.uri.startsWith("spotify:episode:");
		const isCurrentlyLiked = isEpisode
			? await this.isEpisodeSaved(settings, track.id)
			: await this.isTrackSaved(settings, track.uri);

		if (isCurrentlyLiked) {
			const success = isEpisode
				? await this.removeEpisode(settings, track.id)
				: await this.removeTrack(settings, track.uri);
			return { success, isLiked: false };
		}
		const success = isEpisode
			? await this.saveEpisode(settings, track.id)
			: await this.saveTrack(settings, track.uri);
		return { success, isLiked: true };
	}

	private async playerMethod(settings: SpotifySettings, url: string, method: "PUT" | "POST"): Promise<boolean> {
		const response = await this.requestWithAuth(settings, url, { method });
		if (!response) return false;
		if (response.status === 429) {
			this.warn429("player", response);
			return false;
		}
		return response.ok || response.status === 204;
	}

	async playPause(settings: SpotifySettings): Promise<boolean> {
		const track = await this.getCurrentTrack(settings);
		const endpoint = track?.isPlaying
			? "https://api.spotify.com/v1/me/player/pause"
			: "https://api.spotify.com/v1/me/player/play";
		return this.playerMethod(settings, endpoint, "PUT");
	}

	async nextTrack(settings: SpotifySettings): Promise<boolean> {
		return this.playerMethod(settings, "https://api.spotify.com/v1/me/player/next", "POST");
	}

	async previousTrack(settings: SpotifySettings): Promise<boolean> {
		return this.playerMethod(settings, "https://api.spotify.com/v1/me/player/previous", "POST");
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
		this.pollInterval = setInterval(() => this.poll(), 3000);
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

		let isLiked = false;

		// Only check liked status if track changed or first poll
		if (track && (track.id !== this.lastTrackId || this.lastTrackId === null)) {
			isLiked = track.uri.startsWith("spotify:episode:")
				? await spotifyAPI.isEpisodeSaved(settings, track.id)
				: await spotifyAPI.isTrackSaved(settings, track.uri);
			this.lastTrackId = track.id;
		} else if (!track) {
			this.lastTrackId = null;
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

		const t = this.currentState.track;
		const isLiked = t.uri.startsWith("spotify:episode:")
			? await spotifyAPI.isEpisodeSaved(settings, t.id)
			: await spotifyAPI.isTrackSaved(settings, t.uri);
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
	item: SpotifyPlayingItem | null;
};
