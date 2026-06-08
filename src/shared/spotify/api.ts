import streamDeck from "@elgato/streamdeck";
import { getSpotifySettings, saveSpotifySettings } from "./settings";
import { spotifyApiGateway } from "./api-gateway";
import { spotifyApiMetrics } from "./api-metrics";
import { spotifyRateLimit } from "./rate-limit";
import type { SpotifySettings, SpotifyTrack } from "./types";

const MAX_URI_CACHE_ENTRIES = 200;

export class SpotifyAPI {
	private uriCache = new Map<string, string>();
	private resolveInFlight = new Map<string, Promise<string | null>>();
	private uriCacheHydrated = false;

	hasCachedUri(trackId: string): boolean {
		return this.uriCache.has(trackId);
	}

	hydrateUriCache(settings: SpotifySettings): void {
		if (this.uriCacheHydrated) {
			return;
		}
		this.uriCacheHydrated = true;
		const cached = settings.trackUriCache;
		if (!cached) {
			return;
		}
		for (const [trackId, uri] of Object.entries(cached)) {
			this.uriCache.set(trackId, uri);
		}
	}

	private persistUriCache(): void {
		const settings = getSpotifySettings();
		const entries = [...this.uriCache.entries()]
			.slice(-MAX_URI_CACHE_ENTRIES)
			.map(([trackId, uri]) => [trackId, uri] as const);
		void saveSpotifySettings({
			...settings,
			trackUriCache: Object.fromEntries(entries)
		});
	}

	private rememberUri(trackId: string, uri: string): void {
		this.uriCache.set(trackId, uri);
		this.persistUriCache();
	}

	private trackContext(track: SpotifyTrack): { title: string; artist: string } {
		return { title: track.name, artist: track.artist };
	}

	private async requestWithAuth(
		settings: SpotifySettings,
		url: string,
		init?: { method?: "PUT" | "POST" | "DELETE"; headers?: Record<string, string> },
		options?: { bypassLibraryThrottle?: boolean; reason?: string; track?: SpotifyTrack }
	): Promise<Response | null> {
		return spotifyApiGateway.request(settings, url, {
			method: init?.method ?? "GET",
			headers: init?.headers,
			reason: options?.reason ?? "api",
			bypassLibraryThrottle: options?.bypassLibraryThrottle,
			priority: options?.bypassLibraryThrottle ? "manual" : "normal",
			track: options?.track ? this.trackContext(options.track) : undefined
		});
	}

	private async isSavedUri(
		settings: SpotifySettings,
		uri: string,
		bypassThrottle = false,
		track?: SpotifyTrack
	): Promise<boolean | null> {
		const response = await this.requestWithAuth(
			settings,
			`https://api.spotify.com/v1/me/library/contains?uris=${encodeURIComponent(uri)}`,
			undefined,
			{
				bypassLibraryThrottle: bypassThrottle,
				reason: "contains",
				track
			}
		);
		if (!response) return null;
		if (response.status === 429) {
			streamDeck.logger.warn(
				`[Spotify] isSaved 429 retry-after=${response.headers.get("Retry-After") ?? "none"}`
			);
			return null;
		}
		if (response.status === 403) {
			streamDeck.logger.error(
				`[Spotify] isSaved forbidden (403) - re-authorize via Spotify Setup (user-library-read scope)`
			);
			return null;
		}
		if (!response.ok) {
			streamDeck.logger.error(
				`[Spotify] isSaved failed: ${response.status} ${await response.text()}`
			);
			return null;
		}
		const data = (await response.json()) as boolean[];
		return data[0] || false;
	}

	private async setSavedUri(
		settings: SpotifySettings,
		uri: string,
		method: "PUT" | "DELETE",
		track: SpotifyTrack
	): Promise<boolean> {
		const response = await this.requestWithAuth(
			settings,
			`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(uri)}`,
			{ method },
			{
				bypassLibraryThrottle: true,
				reason: method === "PUT" ? "like" : "unlike",
				track
			}
		);
		if (!response) return false;
		if (response.status === 429) {
			streamDeck.logger.warn(
				`[Spotify] ${method === "PUT" ? "save" : "remove"} rate limited (429) retry-after=${response.headers.get("Retry-After") ?? "none"}`
			);
			return false;
		}
		if (!response.ok) {
			streamDeck.logger.error(
				`[Spotify] ${method === "PUT" ? "save" : "remove"} failed: ${response.status} ${await response.text()}`
			);
			return false;
		}
		spotifyRateLimit.clearLibraryGiveUp();
		return true;
	}

	private async searchTrackUri(
		settings: SpotifySettings,
		query: string,
		reason: string,
		track: SpotifyTrack
	): Promise<string | null> {
		const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`;
		const response = await this.requestWithAuth(settings, url, undefined, {
			reason: `search:${reason}`,
			track
		});
		if (!response) {
			streamDeck.logger.warn(`[Spotify] resolveTrackUri (${reason}): search blocked or failed`);
			return null;
		}
		if (response.status === 429) {
			streamDeck.logger.warn(`[Spotify] resolveTrackUri (${reason}): search rate limited`);
			return null;
		}
		if (!response.ok) {
			streamDeck.logger.error(
				`[Spotify] resolveTrackUri (${reason}): ${response.status} ${await response.text()}`
			);
			return null;
		}

		try {
			const data = (await response.json()) as {
				tracks?: { items?: { uri: string }[] };
			};
			return data.tracks?.items?.[0]?.uri ?? null;
		} catch (e) {
			streamDeck.logger.error("[Spotify] resolveTrackUri parse error: " + e);
			return null;
		}
	}

	private buildSearchQuery(track: SpotifyTrack): string | null {
		const name = track.name.trim();
		const artist = track.artist.trim();
		if (!name || !artist) {
			return name ? `track:"${name}"` : null;
		}
		return `track:"${name}" artist:"${artist}"`;
	}

	private async resolveTrackUriInner(
		settings: SpotifySettings,
		track: SpotifyTrack,
		reason: string
	): Promise<string | null> {
		const query = this.buildSearchQuery(track);
		if (!query) {
			streamDeck.logger.warn(
				`[Spotify] resolveTrackUri (${reason}): no query for "${track.name}"`
			);
			return null;
		}

		const uri = await this.searchTrackUri(settings, query, reason, track);
		if (uri) {
			this.rememberUri(track.id, uri);
			streamDeck.logger.debug(
				`[Spotify] resolveTrackUri (${reason}): "${track.name}" -> ${uri}`
			);
			return uri;
		}

		streamDeck.logger.warn(
			`[Spotify] resolveTrackUri (${reason}): no match for "${track.name}" by "${track.artist}"`
		);
		return null;
	}

	async resolveTrackUri(
		settings: SpotifySettings,
		track: SpotifyTrack,
		reason = "unknown"
	): Promise<string | null> {
		if (track.uri.startsWith("spotify:")) {
			return track.uri;
		}

		const cached = this.uriCache.get(track.id);
		if (cached) {
			spotifyApiMetrics.record({
				kind: "cache_hit",
				bucket: "search",
				method: "GET",
				endpoint: "/v1/search",
				reason: `uri-cache:${reason}`,
				track: this.trackContext(track)
			});
			return cached;
		}

		const inflight = this.resolveInFlight.get(track.id);
		if (inflight) {
			return inflight;
		}

		const promise = this.resolveTrackUriInner(settings, track, reason);
		this.resolveInFlight.set(track.id, promise);
		try {
			return await promise;
		} finally {
			this.resolveInFlight.delete(track.id);
		}
	}

	async isTrackSaved(
		settings: SpotifySettings,
		trackUri: string,
		bypassThrottle = false,
		track?: SpotifyTrack
	): Promise<boolean | null> {
		return this.isSavedUri(settings, trackUri, bypassThrottle, track);
	}

	async isEpisodeSaved(settings: SpotifySettings, episodeId: string): Promise<boolean | null> {
		return this.isSavedUri(settings, `spotify:episode:${episodeId}`);
	}

	async isTrackLiked(
		settings: SpotifySettings,
		track: SpotifyTrack,
		reason = "unknown",
		options?: { skipSearch?: boolean; bypassContainsThrottle?: boolean }
	): Promise<boolean | null> {
		let uri: string | null = null;

		if (track.uri.startsWith("spotify:")) {
			uri = track.uri;
		} else {
			const cached = this.uriCache.get(track.id);
			if (cached) {
				uri = cached;
			} else if (!options?.skipSearch) {
				uri = await this.resolveTrackUri(settings, track, reason);
			}
		}

		if (!uri) {
			return null;
		}
		if (uri.startsWith("spotify:episode:")) {
			streamDeck.logger.debug(`[Spotify] Like check skipped (${reason}): episode "${track.name}"`);
			return false;
		}
		return this.isTrackSaved(settings, uri, options?.bypassContainsThrottle === true, track);
	}

	async setLike(settings: SpotifySettings, track: SpotifyTrack, liked: boolean): Promise<boolean> {
		const uri = await this.resolveTrackUri(settings, track, "toggle-like");
		if (!uri) {
			return false;
		}
		return this.setSavedUri(settings, uri, liked ? "PUT" : "DELETE", track);
	}
}

export const spotifyAPI = new SpotifyAPI();
