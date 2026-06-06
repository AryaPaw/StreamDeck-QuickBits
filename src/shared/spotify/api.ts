import streamDeck from "@elgato/streamdeck";
import { spotifyAuth } from "./auth";
import { spotifyRateLimit } from "./rate-limit";
import type { SpotifySettings, SpotifyTrack } from "./types";

export class SpotifyAPI {
	private uriCache = new Map<string, string>();

	private async requestWithAuth(
		settings: SpotifySettings,
		url: string,
		init?: { method?: "PUT" | "POST" | "DELETE"; headers?: Record<string, string> }
	): Promise<Response | null> {
		if (spotifyRateLimit.shouldThrottle()) {
			return null;
		}

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

			if (response.status === 429) {
				spotifyRateLimit.record429("request", response);
				return response;
			}

			if (response.ok || response.status === 204) {
				spotifyRateLimit.recordSuccess();
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
		if (response.status === 429) return false;
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
		if (response.status === 429) return false;
		if (!response.ok) {
			streamDeck.logger.error(
				`[Spotify] ${method === "PUT" ? "save" : "remove"} failed: ${response.status} ${await response.text()}`
			);
		}
		return response.ok;
	}

	async resolveTrackUri(settings: SpotifySettings, track: SpotifyTrack): Promise<string | null> {
		if (track.uri.startsWith("spotify:")) {
			return track.uri;
		}

		const cached = this.uriCache.get(track.id);
		if (cached) {
			return cached;
		}

		const q = `track:${track.name} artist:${track.artist}`;
		const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`;
		const response = await this.requestWithAuth(settings, url);
		if (!response?.ok) {
			return null;
		}

		try {
			const data = (await response.json()) as {
				tracks?: { items?: { uri: string }[] };
			};
			const uri = data.tracks?.items?.[0]?.uri;
			if (uri) {
				this.uriCache.set(track.id, uri);
			}
			return uri ?? null;
		} catch (e) {
			streamDeck.logger.error("[Spotify] resolveTrackUri parse error: " + e);
			return null;
		}
	}

	async isTrackSaved(settings: SpotifySettings, trackUri: string): Promise<boolean> {
		return this.isSavedUri(settings, trackUri);
	}

	async isEpisodeSaved(settings: SpotifySettings, episodeId: string): Promise<boolean> {
		return this.isSavedUri(settings, `spotify:episode:${episodeId}`);
	}

	async isTrackLiked(settings: SpotifySettings, track: SpotifyTrack): Promise<boolean> {
		const uri = await this.resolveTrackUri(settings, track);
		if (!uri || uri.startsWith("spotify:episode:")) {
			return false;
		}
		return this.isTrackSaved(settings, uri);
	}

	async setLike(settings: SpotifySettings, track: SpotifyTrack, liked: boolean): Promise<boolean> {
		const uri = await this.resolveTrackUri(settings, track);
		if (!uri) {
			return false;
		}
		return this.setSavedUri(settings, uri, liked ? "PUT" : "DELETE");
	}
}

export const spotifyAPI = new SpotifyAPI();
