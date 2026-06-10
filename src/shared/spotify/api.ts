import streamDeck from "@elgato/streamdeck";
import {
	artistMatchesGsmtc,
	isSameAlbumName,
	isSameTrackTitle,
	metadataMatchesPlayer,
	normalizeArtistKey,
	normalizeTrackTitle
} from "./local/map";
import { getSpotifySettings, saveSpotifySettings } from "./settings";
import { spotifyApiGateway } from "./api-gateway";
import type { SpotifySettings, SpotifyTrack } from "./types";

const MAX_URI_CACHE_ENTRIES = 200;
const SEARCH_LIMIT = 10;
const MAX_SEARCH_QUERIES = 2;
const PLAYER_RETRY_ATTEMPTS = 3;
const PLAYER_RETRY_DELAY_MS = 400;
const PLAYER_RETRY_REASONS = new Set(["track-changed", "like-button-appear", "retry"]);

type SearchTrackItem = {
	uri: string;
	name: string;
	artists: { name: string }[];
	album?: { name: string; album_type?: string };
	external_ids?: { isrc?: string };
};

type PlayerTrackInfo = {
	uri: string;
	name: string;
	artists: string;
	album: string;
};


export class SpotifyAPI {
	private uriCache = new Map<string, string>();
	private resolveInFlight = new Map<string, Promise<string | null>>();
	private uriCacheHydrated = false;

	hasCachedUri(trackId: string): boolean {
		return this.uriCache.has(trackId);
	}

	getCachedUri(trackId: string): string | undefined {
		return this.uriCache.get(trackId);
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

	private rememberUri(trackId: string, uri: string): string | undefined {
		const previous = this.uriCache.get(trackId);
		this.uriCache.set(trackId, uri);
		this.persistUriCache();
		return previous !== uri ? previous : undefined;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private shouldRetryPlayer(reason: string): boolean {
		return PLAYER_RETRY_REASONS.has(reason);
	}

	private async resolvePlayerTrack(
		settings: SpotifySettings,
		track: SpotifyTrack,
		reason: string
	): Promise<PlayerTrackInfo | null> {
		const maxAttempts = this.shouldRetryPlayer(reason) ? PLAYER_RETRY_ATTEMPTS : 1;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const playerTrack = await this.getPlayerTrack(settings, track);
			if (playerTrack && metadataMatchesPlayer(track, playerTrack)) {
				if (attempt > 0) {
					streamDeck.logger.info(
						`[Spotify] player matched (${reason}) on attempt ${attempt + 1} for "${track.name}" -> ${playerTrack.uri}`
					);
				}
				return playerTrack;
			}
			if (playerTrack) {
				streamDeck.logger.debug(
					`[Spotify] player mismatch (${reason}) attempt ${attempt + 1}/${maxAttempts}: gsmtc="${track.name}" player="${playerTrack.name}" by "${playerTrack.artists}" uri=${playerTrack.uri}`
				);
			}
			if (attempt < maxAttempts - 1) {
				await this.sleep(PLAYER_RETRY_DELAY_MS);
			}
		}
		return null;
	}

	private async batchContainsUris(
		settings: SpotifySettings,
		uris: string[],
		track: SpotifyTrack
	): Promise<boolean[] | null> {
		if (uris.length === 0) {
			return [];
		}
		const joined = uris.map((uri) => encodeURIComponent(uri)).join(",");
		const response = await this.requestWithAuth(
			settings,
			`https://api.spotify.com/v1/me/library/contains?uris=${joined}`,
			undefined,
			{ reason: "contains-batch", track }
		);
		if (!response || !response.ok) {
			return null;
		}
		try {
			const data = (await response.json()) as boolean[];
			return uris.map((_, index) => data[index] === true);
		} catch {
			return null;
		}
	}

	private async pickUriFromSearchCandidates(
		settings: SpotifySettings,
		items: SearchTrackItem[],
		track: SpotifyTrack,
		reason: string
	): Promise<string | null> {
		const scored = items
			.map((item) => ({ item, score: this.scoreSearchCandidate(item, track) }))
			.filter((entry) => entry.score >= 0)
			.sort((a, b) => b.score - a.score);

		if (scored.length === 0) {
			return null;
		}

		const uniqueUris: string[] = [];
		const uriToItem = new Map<string, SearchTrackItem>();
		for (const entry of scored) {
			if (!uriToItem.has(entry.item.uri)) {
				uriToItem.set(entry.item.uri, entry.item);
				uniqueUris.push(entry.item.uri);
			}
		}

		if (uniqueUris.length === 1) {
			return uniqueUris[0] ?? null;
		}

		const likedFlags = await this.batchContainsUris(settings, uniqueUris, track);
		if (likedFlags === null) {
			streamDeck.logger.warn(
				`[Spotify] resolveTrackUri (${reason}): batch contains failed for "${track.name}", skipping disambiguation`
			);
			return null;
		}
		const likedUris = uniqueUris.filter((_, index) => likedFlags[index]);
		if (likedUris.length === 1) {
			streamDeck.logger.info(
				`[Spotify] resolveTrackUri (${reason}): uri-source=search-liked-pick "${track.name}" -> ${likedUris[0]} (1 liked among ${uniqueUris.length} candidates)`
			);
			return likedUris[0] ?? null;
		}
		if (likedUris.length > 1) {
			const likedSet = new Set(likedUris);
			const bestLiked = scored.find((entry) => likedSet.has(entry.item.uri));
			if (bestLiked) {
				streamDeck.logger.info(
					`[Spotify] resolveTrackUri (${reason}): uri-source=search-liked-pick "${track.name}" -> ${bestLiked.item.uri} (${likedUris.length} liked, picked best score)`
				);
				return bestLiked.item.uri;
			}
		}

		return scored[0]?.item.uri ?? null;
	}

	private trackContext(track: SpotifyTrack): { title: string; artist: string } {
		return { title: track.name, artist: track.artist };
	}

	private async requestWithAuth(
		settings: SpotifySettings,
		url: string,
		init?: { method?: "PUT" | "POST" | "DELETE"; headers?: Record<string, string> },
		options?: { bypassQuota?: boolean; reason?: string; track?: SpotifyTrack }
	): Promise<Response | null> {
		return spotifyApiGateway.request(settings, url, {
			method: init?.method ?? "GET",
			headers: init?.headers,
			reason: options?.reason ?? "api",
			bypassQuota: options?.bypassQuota,
			bypassLibraryThrottle: options?.bypassQuota,
			priority: options?.bypassQuota ? "manual" : "normal",
			track: options?.track ? this.trackContext(options.track) : undefined
		});
	}

	async fetchUserProfile(
		settings: SpotifySettings
	): Promise<{ display_name: string; id: string } | null> {
		const response = await this.requestWithAuth(settings, "https://api.spotify.com/v1/me", undefined, {
			reason: "profile"
		});
		if (!response || !response.ok) {
			return null;
		}
		try {
			const data = (await response.json()) as { display_name?: string; id?: string };
			if (!data.display_name || !data.id) {
				return null;
			}
			return { display_name: data.display_name, id: data.id };
		} catch {
			return null;
		}
	}

	private async getPlayerTrack(
		settings: SpotifySettings,
		track: SpotifyTrack
	): Promise<PlayerTrackInfo | null> {
		const response = await this.requestWithAuth(
			settings,
			"https://api.spotify.com/v1/me/player",
			undefined,
			{ reason: "player", track }
		);
		if (!response) {
			return null;
		}
		if (response.status === 204) {
			return null;
		}
		if (!response.ok) {
			streamDeck.logger.debug(
				`[Spotify] getPlayerTrack: ${response.status} ${await response.text()}`
			);
			return null;
		}

		try {
			const data = (await response.json()) as {
				item?: {
					type?: string;
					uri?: string;
					name?: string;
					artists?: { name: string }[];
					album?: { name?: string };
				} | null;
			};
			const item = data.item;
			if (!item || item.type !== "track" || !item.uri || !item.name) {
				return null;
			}
			const artists = (item.artists ?? []).map((artist) => artist.name).join(", ");
			return {
				uri: item.uri,
				name: item.name,
				artists,
				album: item.album?.name ?? ""
			};
		} catch (e) {
			streamDeck.logger.error("[Spotify] getPlayerTrack parse error: " + e);
			return null;
		}
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
				bypassQuota: bypassThrottle,
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
				bypassQuota: true,
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
		return true;
	}

	private stripApostrophes(value: string): string {
		return value.replace(/[\u2018\u2019']/g, "");
	}

	private simplifyTrackTitle(title: string): string {
		return title
			.replace(/\s*\([^)]*from[^)]*\)\s*/gi, " ")
			.replace(/\s*\([^)]*tribute[^)]*\)\s*/gi, " ")
			.replace(/\s*\[[^\]]*\]\s*/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private titleMatches(expected: string, candidate: string): boolean {
		if (isSameTrackTitle(expected, candidate)) {
			return true;
		}
		const simplifiedExpected = this.simplifyTrackTitle(expected);
		const simplifiedCandidate = this.simplifyTrackTitle(candidate);
		if (
			simplifiedExpected &&
			simplifiedCandidate &&
			isSameTrackTitle(simplifiedExpected, simplifiedCandidate)
		) {
			return true;
		}
		const normalizedExpected = normalizeTrackTitle(expected);
		const normalizedCandidate = normalizeTrackTitle(candidate);
		return (
			normalizedExpected.includes(normalizedCandidate) ||
			normalizedCandidate.includes(normalizedExpected)
		);
	}

	private scoreSearchCandidate(item: SearchTrackItem, track: SpotifyTrack): number {
		if (!this.titleMatches(track.name, item.name)) {
			return -1;
		}

		let score = 10;
		if (this.artistMatches(item.artists, track.artist)) {
			score += 20;
		} else if (!track.artist || track.artist === "Unknown") {
			score += 5;
		} else {
			return -1;
		}

		const gsmtcAlbum = track.album.trim();
		const itemAlbum = item.album?.name?.trim() ?? "";
		if (gsmtcAlbum && itemAlbum && isSameAlbumName(gsmtcAlbum, itemAlbum)) {
			score += 15;
		} else if (
			gsmtcAlbum &&
			itemAlbum &&
			(isSameAlbumName(gsmtcAlbum, track.name) || isSameAlbumName(itemAlbum, track.name))
		) {
			score += 8;
		}

		if (item.album?.album_type === "single" && gsmtcAlbum && isSameAlbumName(gsmtcAlbum, itemAlbum)) {
			score += 3;
		}

		return score;
	}

	private artistMatches(artists: { name: string }[], expected: string): boolean {
		return artistMatchesGsmtc(
			artists.map((artist) => artist.name),
			expected
		);
	}

	private logSearchCandidates(items: SearchTrackItem[], track: SpotifyTrack, reason: string): void {
		if (items.length === 0) {
			return;
		}
		const lines = items.map((item) => {
			const artists = item.artists.map((artist) => artist.name).join(", ");
			const album = item.album?.name ?? "";
			const albumType = item.album?.album_type ?? "";
			const score = this.scoreSearchCandidate(item, track);
			return `${score >= 0 ? score : "skip"} | ${item.name} | ${artists} | ${album} (${albumType}) | ${item.uri}`;
		});
		streamDeck.logger.debug(
			`[Spotify] resolveTrackUri (${reason}) candidates:\n  ${lines.join("\n  ")}`
		);
	}

	private async searchTrackCandidates(
		settings: SpotifySettings,
		query: string,
		reason: string,
		track: SpotifyTrack
	): Promise<SearchTrackItem[]> {
		const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${SEARCH_LIMIT}`;
		const response = await this.requestWithAuth(settings, url, undefined, {
			reason: `search:${reason}`,
			track
		});
		if (!response) {
			streamDeck.logger.warn(`[Spotify] resolveTrackUri (${reason}): search blocked or failed`);
			return [];
		}
		if (response.status === 429) {
			streamDeck.logger.warn(`[Spotify] resolveTrackUri (${reason}): search rate limited`);
			return [];
		}
		if (!response.ok) {
			streamDeck.logger.error(
				`[Spotify] resolveTrackUri (${reason}): ${response.status} ${await response.text()}`
			);
			return [];
		}

		try {
			const data = (await response.json()) as {
				tracks?: { items?: SearchTrackItem[] };
			};
			return data.tracks?.items ?? [];
		} catch (e) {
			streamDeck.logger.error("[Spotify] resolveTrackUri parse error: " + e);
			return [];
		}
	}

	private quoteSearchField(value: string): string {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}

	private buildSearchQueries(track: SpotifyTrack): string[] {
		const name = track.name.trim();
		const artist = track.artist.trim();
		const primaryArtist = normalizeArtistKey(artist);
		const simplifiedName = this.simplifyTrackTitle(name);
		const nameNoApostrophe = this.stripApostrophes(name);
		const queries: string[] = [];
		const seen = new Set<string>();

		const add = (query: string | null) => {
			if (!query || seen.has(query)) {
				return;
			}
			seen.add(query);
			queries.push(query);
		};

		const album = track.album.trim();

		if (name && primaryArtist) {
			add(
				`track:${this.quoteSearchField(name)} artist:${this.quoteSearchField(primaryArtist)}`
			);
		}
		if (name && primaryArtist && album) {
			add(
				`track:${this.quoteSearchField(name)} artist:${this.quoteSearchField(primaryArtist)} album:${this.quoteSearchField(album)}`
			);
		}
		if (name && artist && artist !== "Unknown") {
			add(`track:${this.quoteSearchField(name)} artist:${this.quoteSearchField(artist)}`);
		}
		if (nameNoApostrophe && primaryArtist && nameNoApostrophe !== name) {
			add(
				`track:${this.quoteSearchField(nameNoApostrophe)} artist:${this.quoteSearchField(primaryArtist)}`
			);
			add(`track:${nameNoApostrophe} artist:${primaryArtist}`);
		}
		if (name && primaryArtist) {
			add(`track:${name} artist:${primaryArtist}`);
		}
		if (simplifiedName && simplifiedName !== name && artist && artist !== "Unknown") {
			add(
				`track:${this.quoteSearchField(simplifiedName)} artist:${this.quoteSearchField(artist)}`
			);
		}
		if (nameNoApostrophe && nameNoApostrophe !== name) {
			add(`track:${this.quoteSearchField(nameNoApostrophe)}`);
		}
		if (name) {
			add(`track:${this.quoteSearchField(name)}`);
		}
		if (name && artist && artist !== "Unknown") {
			add(`${normalizeTrackTitle(name)} ${primaryArtist}`);
		}

		return queries;
	}

	private async searchResolveTrackUri(
		settings: SpotifySettings,
		track: SpotifyTrack,
		reason: string
	): Promise<string | null> {
		const queries = this.buildSearchQueries(track).slice(0, MAX_SEARCH_QUERIES);
		if (queries.length === 0) {
			streamDeck.logger.warn(
				`[Spotify] resolveTrackUri (${reason}): no query for "${track.name}"`
			);
			return null;
		}

		const allCandidates: SearchTrackItem[] = [];
		const seenUris = new Set<string>();

		for (const query of queries) {
			const items = await this.searchTrackCandidates(settings, query, reason, track);
			for (const item of items) {
				if (!seenUris.has(item.uri)) {
					seenUris.add(item.uri);
					allCandidates.push(item);
				}
			}
			if (allCandidates.length >= SEARCH_LIMIT) {
				break;
			}
		}

		if (allCandidates.length === 0) {
			streamDeck.logger.warn(
				`[Spotify] resolveTrackUri (${reason}): no search match for "${track.name}" by "${track.artist}"`
			);
			return null;
		}

		this.logSearchCandidates(allCandidates, track, reason);
		const uri = await this.pickUriFromSearchCandidates(settings, allCandidates, track, reason);
		if (uri) {
			streamDeck.logger.debug(
				`[Spotify] resolveTrackUri (${reason}): uri-source=search "${track.name}" -> ${uri}`
			);
		}
		return uri;
	}

	private async resolveTrackUriInner(
		settings: SpotifySettings,
		track: SpotifyTrack,
		reason: string
	): Promise<string | null> {
		const previousUri = this.uriCache.get(track.id);

		const playerTrack = await this.resolvePlayerTrack(settings, track, reason);
		if (playerTrack) {
			const replaced = this.rememberUri(track.id, playerTrack.uri);
			streamDeck.logger.info(
				`[Spotify] resolveTrackUri (${reason}): uri-source=player "${track.name}" -> ${playerTrack.uri}${replaced ? ` (was ${replaced})` : ""}`
			);
			return playerTrack.uri;
		}

		const searchUri = await this.searchResolveTrackUri(settings, track, reason);
		if (searchUri) {
			const replaced = this.rememberUri(track.id, searchUri);
			if (replaced && replaced !== searchUri) {
				streamDeck.logger.info(
					`[Spotify] resolveTrackUri (${reason}): uri-source=search replaced cached ${replaced} -> ${searchUri}`
				);
			}
			return searchUri;
		}

		if (previousUri) {
			streamDeck.logger.debug(
				`[Spotify] resolveTrackUri (${reason}): uri-source=cache-fallback "${track.name}" -> ${previousUri}`
			);
			return previousUri;
		}

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
		options?: { bypassContainsThrottle?: boolean }
	): Promise<boolean | null> {
		let uri: string | null = null;

		if (track.uri.startsWith("spotify:")) {
			uri = track.uri;
		} else {
			uri = await this.resolveTrackUri(settings, track, reason);
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
