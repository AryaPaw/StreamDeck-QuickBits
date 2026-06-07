import streamDeck from "@elgato/streamdeck";
import { spotifyAuth } from "./auth";
import { spotifyRateLimit } from "./rate-limit";
import type { SpotifySettings, SpotifyTrack } from "./types";

export class SpotifyAPI {
	private uriCache = new Map<string, string>();
	private resolveInFlight = new Map<string, Promise<string | null>>();

	private async requestWithAuth(
		settings: SpotifySettings,
		url: string,
		init?: { method?: "PUT" | "POST" | "DELETE"; headers?: Record<string, string> },
		clearRateLimitOnSuccess = true
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

			if ((response.ok || response.status === 204) && clearRateLimitOnSuccess) {
				spotifyRateLimit.recordSuccess();
			}

			return response;
		} catch (e) {
			streamDeck.logger.error(`[Spotify] request failed: ${url} ${e}`);
			return null;
		}
	}

	private async isSavedUri(settings: SpotifySettings, uri: string): Promise<boolean | null> {
		const response = await this.requestWithAuth(
			settings,
			`https://api.spotify.com/v1/me/library/contains?uris=${encodeURIComponent(uri)}`
		);
		if (!response) return null;
		if (response.status === 429) return null;
		if (!response.ok) {
			streamDeck.logger.error(
				`[Spotify] isSaved failed: ${response.status} ${await response.text()}`
			);
			return null;
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

	private buildSearchQueries(track: SpotifyTrack): string[] {
		const name = track.name.trim();
		const artist = track.artist.trim();
		const album = track.album.trim();
		const queries: string[] = [];

		if (name && artist) {
			queries.push(`track:"${name}" artist:"${artist}"`);
			queries.push(`track:${name} artist:${artist}`);
		}
		if (name) {
			queries.push(`track:"${name}"`);
		}
		if (name && album) {
			queries.push(`track:"${name}" album:"${album}"`);
		}

		return queries;
	}

	private async searchTrackUri(
		settings: SpotifySettings,
		query: string,
		reason: string
	): Promise<string | null> {
		const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`;
		const response = await this.requestWithAuth(settings, url, undefined, false);
		if (!response) {
			return null;
		}
		if (response.status === 429) {
			streamDeck.logger.warn(`[Spotify] resolveTrackUri (${reason}): rate limited`);
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

	private async resolveTrackUriInner(
		settings: SpotifySettings,
		track: SpotifyTrack,
		reason: string
	): Promise<string | null> {
		const queries = this.buildSearchQueries(track);
		for (const query of queries) {
			const uri = await this.searchTrackUri(settings, query, reason);
			if (uri) {
				this.uriCache.set(track.id, uri);
				streamDeck.logger.debug(
					`[Spotify] resolveTrackUri (${reason}): "${track.name}" -> ${uri} (q=${query})`
				);
				return uri;
			}
			if (spotifyRateLimit.shouldThrottle()) {
				break;
			}
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

	async isTrackSaved(settings: SpotifySettings, trackUri: string): Promise<boolean | null> {
		return this.isSavedUri(settings, trackUri);
	}

	async isEpisodeSaved(settings: SpotifySettings, episodeId: string): Promise<boolean | null> {
		return this.isSavedUri(settings, `spotify:episode:${episodeId}`);
	}

	async isTrackLiked(
		settings: SpotifySettings,
		track: SpotifyTrack,
		reason = "unknown"
	): Promise<boolean | null> {
		const uri = await this.resolveTrackUri(settings, track, reason);
		if (!uri) {
			return null;
		}
		if (uri.startsWith("spotify:episode:")) {
			streamDeck.logger.debug(`[Spotify] Like check skipped (${reason}): episode "${track.name}"`);
			return false;
		}
		return this.isTrackSaved(settings, uri);
	}

	async setLike(settings: SpotifySettings, track: SpotifyTrack, liked: boolean): Promise<boolean> {
		const uri = await this.resolveTrackUri(settings, track, "toggle-like");
		if (!uri) {
			return false;
		}
		return this.setSavedUri(settings, uri, liked ? "PUT" : "DELETE");
	}
}

export const spotifyAPI = new SpotifyAPI();
