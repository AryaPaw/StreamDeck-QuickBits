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
import { spotifyApiMetrics } from "./api-metrics";
import type { SpotifySettings, SpotifyTrack } from "./types";

const MAX_URI_CACHE_ENTRIES = 200;
const SEARCH_LIMIT = 10;
const MAX_SEARCH_QUERIES = 2;
const PLAYER_RETRY_ATTEMPTS = 3;
const PLAYER_RETRY_DELAY_MS = 400;
const PLAYER_RETRY_REASONS = new Set(["like-button-appear", "toggle-like"]);
const CONTAINS_CACHE_TTL_MS = 30_000;
const DURATION_MATCH_MS = 2_000;
const DURATION_MISMATCH_MS = 5_000;
const AMBIGUOUS_SCORE_DELTA = 7;

type SearchTrackItem = {
	uri: string;
	name: string;
	artists: { name: string }[];
	album?: { name: string; album_type?: string };
	duration_ms?: number;
	external_ids?: { isrc?: string };
};

type PlayerTrackInfo = {
	uri: string;
	name: string;
	artists: string;
	album: string;
};

type UriResolveSource = "player" | "search" | "cache" | "none";

type SearchPickResult = {
	uri: string | null;
	ambiguous: boolean;
};


export class SpotifyAPI {
	private uriCache = new Map<string, string>();
	private resolveInFlight = new Map<string, Promise<string | null>>();
	private uriCacheHydrated = false;
	private containsCache = new Map<string, { isLiked: boolean; at: number }>();
	private lastResolveSource: UriResolveSource = "none";
	/** Track IDs whose URI was confirmed via /me/player this plugin session */
	private playerConfirmedTrackIds = new Set<string>();

	hasCachedUri(trackId: string): boolean {
		return this.uriCache.has(trackId);
	}

	getCachedUri(trackId: string): string | undefined {
		return this.uriCache.get(trackId);
	}

	/** True if URI for this GSMTC track was resolved from /me/player in this session */
	isPlayerConfirmed(trackId: string): boolean {
		return this.playerConfirmedTrackIds.has(trackId);
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

	private rememberUri(trackId: string, uri: string, fromPlayer = false): string | undefined {
		const previous = this.uriCache.get(trackId);
		this.uriCache.set(trackId, uri);
		this.persistUriCache();
		if (previous && previous !== uri) {
			this.forgetContains(previous);
		}
		if (fromPlayer) {
			this.playerConfirmedTrackIds.add(trackId);
		} else if (previous !== uri) {
			// Search/cache URI is not trusted for cache-hit until player confirms
			this.playerConfirmedTrackIds.delete(trackId);
		}
		return previous !== uri ? previous : undefined;
	}

	forgetCachedUri(trackId: string): void {
		const previous = this.uriCache.get(trackId);
		if (!previous) {
			return;
		}
		this.uriCache.delete(trackId);
		this.playerConfirmedTrackIds.delete(trackId);
		this.forgetContains(previous);
		this.persistUriCache();
	}

	private forgetContains(uri: string): void {
		this.containsCache.delete(uri);
	}

	getLastResolveSource(): UriResolveSource {
		return this.lastResolveSource;
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
		reason: string,
		bypassQuota = false
	): Promise<PlayerTrackInfo | null> {
		const maxAttempts = this.shouldRetryPlayer(reason) ? PLAYER_RETRY_ATTEMPTS : 1;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const playerTrack = await this.getPlayerTrack(settings, track, bypassQuota);
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

	private rememberContains(uri: string, isLiked: boolean): void {
		this.containsCache.set(uri, { isLiked, at: Date.now() });
	}

	private getCachedContains(uri: string): boolean | null {
		const entry = this.containsCache.get(uri);
		if (!entry || Date.now() - entry.at > CONTAINS_CACHE_TTL_MS) {
			return null;
		}
		return entry.isLiked;
	}

	private async batchContainsUris(
		settings: SpotifySettings,
		uris: string[],
		track: SpotifyTrack,
		bypassQuota = false
	): Promise<boolean[] | null> {
		if (uris.length === 0) {
			return [];
		}
		const joined = uris.map((uri) => encodeURIComponent(uri)).join(",");
		const response = await this.requestWithAuth(
			settings,
			`https://api.spotify.com/v1/me/library/contains?uris=${joined}`,
			undefined,
			{ reason: "contains-batch", track, bypassQuota }
		);
		if (!response || !response.ok) {
			return null;
		}
		try {
			const data = (await response.json()) as boolean[];
			return uris.map((uri, index) => {
				const isLiked = data[index] === true;
				this.rememberContains(uri, isLiked);
				return isLiked;
			});
		} catch {
			return null;
		}
	}

	private async pickUriFromSearchCandidates(
		settings: SpotifySettings,
		items: SearchTrackItem[],
		track: SpotifyTrack,
		reason: string,
		bypassQuota = false
	): Promise<SearchPickResult> {
		const scored = items
			.map((item) => ({ item, score: this.scoreSearchCandidate(item, track) }))
			.filter((entry) => entry.score >= 0)
			.sort((a, b) => b.score - a.score);

		if (scored.length === 0) {
			return { uri: null, ambiguous: false };
		}

		const uniqueEntries: { item: SearchTrackItem; score: number }[] = [];
		const seenUris = new Set<string>();
		for (const entry of scored) {
			if (!seenUris.has(entry.item.uri)) {
				seenUris.add(entry.item.uri);
				uniqueEntries.push(entry);
			}
		}

		if (uniqueEntries.length === 1) {
			return { uri: uniqueEntries[0]?.item.uri ?? null, ambiguous: false };
		}

		const uniqueUris = uniqueEntries.map((entry) => entry.item.uri);
		const likedFlags = await this.batchContainsUris(settings, uniqueUris, track, bypassQuota);
		if (likedFlags === null) {
			streamDeck.logger.warn(
				`[Spotify] resolveTrackUri (${reason}): batch contains failed for "${track.name}", skipping disambiguation`
			);
			return { uri: null, ambiguous: true };
		}
		const likedUris = uniqueUris.filter((_, index) => likedFlags[index]);
		if (likedUris.length === 1) {
			streamDeck.logger.info(
				`[Spotify] resolveTrackUri (${reason}): uri-source=search-liked-pick "${track.name}" -> ${likedUris[0]} (1 liked among ${uniqueUris.length} candidates)`
			);
			return { uri: likedUris[0] ?? null, ambiguous: false };
		}
		if (likedUris.length > 1) {
			const likedSet = new Set(likedUris);
			const bestLiked = uniqueEntries.find((entry) => likedSet.has(entry.item.uri));
			if (bestLiked) {
				streamDeck.logger.info(
					`[Spotify] resolveTrackUri (${reason}): uri-source=search-liked-pick "${track.name}" -> ${bestLiked.item.uri} (${likedUris.length} liked, picked best score)`
				);
				return { uri: bestLiked.item.uri, ambiguous: false };
			}
		}

		const top = uniqueEntries[0]!;
		const second = uniqueEntries[1];
		if (second) {
			const durationWinner = this.pickByDuration(top.item, second.item, track);
			if (durationWinner) {
				streamDeck.logger.info(
					`[Spotify] resolveTrackUri (${reason}): uri-source=search-duration-pick "${track.name}" -> ${durationWinner}`
				);
				return { uri: durationWinner, ambiguous: false };
			}

			if (top.score - second.score <= AMBIGUOUS_SCORE_DELTA) {
				streamDeck.logger.warn(
					`[Spotify] resolveTrackUri (${reason}): ambiguous ${uniqueUris.length} candidates for "${track.name}" (scores ${top.score}/${second.score}), refusing cache`
				);
				return { uri: null, ambiguous: true };
			}
		}

		return { uri: top.item.uri, ambiguous: false };
	}

	private durationDelta(item: SearchTrackItem, track: SpotifyTrack): number | null {
		if (!track.duration || track.duration <= 0 || item.duration_ms == null) {
			return null;
		}
		return Math.abs(item.duration_ms - track.duration);
	}

	/** If one candidate clearly matches GSMTC duration better, return its URI */
	private pickByDuration(
		a: SearchTrackItem,
		b: SearchTrackItem,
		track: SpotifyTrack
	): string | null {
		const da = this.durationDelta(a, track);
		const db = this.durationDelta(b, track);
		if (da === null || db === null) {
			return null;
		}
		if (da <= DURATION_MATCH_MS && db - da >= 3_000) {
			return a.uri;
		}
		if (db <= DURATION_MATCH_MS && da - db >= 3_000) {
			return b.uri;
		}
		return null;
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
		track: SpotifyTrack,
		bypassQuota = false
	): Promise<PlayerTrackInfo | null> {
		const response = await this.requestWithAuth(
			settings,
			"https://api.spotify.com/v1/me/player",
			undefined,
			{ reason: "player", track, bypassQuota }
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
		const cached = this.getCachedContains(uri);
		if (cached !== null) {
			spotifyApiMetrics.record({
				kind: "cache_hit",
				bucket: "library",
				method: "GET",
				endpoint: "/v1/me/library/contains",
				reason: "contains-cached",
				track: track ? this.trackContext(track) : undefined
			});
			return cached;
		}

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
		const isLiked = data[0] === true;
		this.rememberContains(uri, isLiked);
		return isLiked;
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
		this.rememberContains(uri, method === "PUT");
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

		const durationDelta = this.durationDelta(item, track);
		if (durationDelta !== null) {
			if (durationDelta <= DURATION_MATCH_MS) {
				score += 12;
			} else if (durationDelta > DURATION_MISMATCH_MS) {
				score -= 8;
			}
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
			const dur =
				item.duration_ms != null ? `${Math.round(item.duration_ms / 1000)}s` : "?s";
			return `${score >= 0 ? score : "skip"} | ${item.name} | ${artists} | ${album} (${albumType}) | ${dur} | ${item.uri}`;
		});
		streamDeck.logger.debug(
			`[Spotify] resolveTrackUri (${reason}) candidates:\n  ${lines.join("\n  ")}`
		);
	}

	private async searchTrackCandidates(
		settings: SpotifySettings,
		query: string,
		reason: string,
		track: SpotifyTrack,
		bypassQuota = false
	): Promise<SearchTrackItem[]> {
		const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${SEARCH_LIMIT}`;
		const response = await this.requestWithAuth(settings, url, undefined, {
			reason: `search:${reason}`,
			track,
			bypassQuota
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
		reason: string,
		bypassQuota = false
	): Promise<SearchPickResult> {
		const queries = this.buildSearchQueries(track).slice(0, MAX_SEARCH_QUERIES);
		if (queries.length === 0) {
			streamDeck.logger.warn(
				`[Spotify] resolveTrackUri (${reason}): no query for "${track.name}"`
			);
			return { uri: null, ambiguous: false };
		}

		const allCandidates: SearchTrackItem[] = [];
		const seenUris = new Set<string>();

		for (const query of queries) {
			const items = await this.searchTrackCandidates(settings, query, reason, track, bypassQuota);
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
			return { uri: null, ambiguous: false };
		}

		this.logSearchCandidates(allCandidates, track, reason);
		const pick = await this.pickUriFromSearchCandidates(
			settings,
			allCandidates,
			track,
			reason,
			bypassQuota
		);
		if (pick.uri) {
			streamDeck.logger.debug(
				`[Spotify] resolveTrackUri (${reason}): uri-source=search "${track.name}" -> ${pick.uri}`
			);
		}
		return pick;
	}

	private async resolveTrackUriInner(
		settings: SpotifySettings,
		track: SpotifyTrack,
		reason: string
	): Promise<string | null> {
		const previousUri = this.uriCache.get(track.id);
		const bypassQuota = reason === "toggle-like";
		this.lastResolveSource = "none";

		const playerTrack = await this.resolvePlayerTrack(settings, track, reason, bypassQuota);
		if (playerTrack) {
			const replaced = this.rememberUri(track.id, playerTrack.uri, true);
			if (replaced) {
				streamDeck.logger.info(
					`[Spotify] resolveTrackUri (${reason}): uri corrected "${track.name}" ${replaced} -> ${playerTrack.uri}`
				);
			} else {
				streamDeck.logger.info(
					`[Spotify] resolveTrackUri (${reason}): uri-source=player "${track.name}" -> ${playerTrack.uri}`
				);
			}
			this.lastResolveSource = "player";
			return playerTrack.uri;
		}

		const search = await this.searchResolveTrackUri(settings, track, reason, bypassQuota);
		if (search.ambiguous) {
			if (previousUri) {
				this.forgetCachedUri(track.id);
			}
			streamDeck.logger.warn(
				`[Spotify] resolveTrackUri (${reason}): ambiguous candidates for "${track.name}", refusing toggle/cache`
			);
			this.lastResolveSource = "none";
			return null;
		}
		if (search.uri) {
			const replaced = this.rememberUri(track.id, search.uri, false);
			if (replaced && replaced !== search.uri) {
				streamDeck.logger.info(
					`[Spotify] resolveTrackUri (${reason}): uri-source=search replaced cached ${replaced} -> ${search.uri}`
				);
			}
			this.lastResolveSource = "search";
			return search.uri;
		}

		// Cache fallback only when search was not ambiguous (poisoned cache risk)
		if (previousUri && reason !== "toggle-like") {
			streamDeck.logger.debug(
				`[Spotify] resolveTrackUri (${reason}): uri-source=cache-fallback "${track.name}" -> ${previousUri}`
			);
			this.lastResolveSource = "cache";
			return previousUri;
		}

		// Manual like: allow cache only as last resort when player+search both empty (not ambiguous)
		if (previousUri && reason === "toggle-like") {
			streamDeck.logger.warn(
				`[Spotify] resolveTrackUri (${reason}): uri-source=cache-fallback "${track.name}" -> ${previousUri} (player/search unavailable)`
			);
			this.lastResolveSource = "cache";
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
		} else if (reason === "retry") {
			uri = this.getCachedUri(track.id) ?? null;
			if (!uri) {
				return null;
			}
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
		spotifyApiGateway.resetLastError();
		const action = liked ? "like" : "unlike";
		const previousUri = this.getCachedUri(track.id);
		const uri = await this.resolveTrackUri(settings, track, "toggle-like");
		const source = this.lastResolveSource;
		if (!uri) {
			const reason =
				spotifyApiGateway.getLastError() ??
				(source === "none" ? "ambiguous or no uri" : "no uri");
			streamDeck.logger.warn(
				`[Spotify] Like toggle failed: ${reason} for "${track.name}" by "${track.artist}" (${action}) source=${source}`
			);
			return false;
		}
		if (previousUri && previousUri !== uri) {
			streamDeck.logger.info(
				`[Spotify] Like toggle uri corrected: ${previousUri} -> ${uri} for "${track.name}"`
			);
		}

		const ok = await this.setSavedUri(settings, uri, liked ? "PUT" : "DELETE", track);
		if (!ok) {
			const reason = spotifyApiGateway.getLastError() ?? `${action} request failed`;
			streamDeck.logger.warn(
				`[Spotify] Like toggle failed: ${reason} for "${track.name}" uri=${uri} (${action}) source=${source}`
			);
			return false;
		}

		// Soft verify - catches silent API failure, not wrong-URI
		this.forgetContains(uri);
		const verified = await this.isSavedUri(settings, uri, true, track);
		if (verified !== null && verified !== liked) {
			streamDeck.logger.warn(
				`[Spotify] Like toggle verify failed: expected ${liked ? "liked" : "not liked"} uri=${uri} for "${track.name}"`
			);
			return false;
		}

		streamDeck.logger.info(
			`[Spotify] Like toggle succeeded: uri=${uri} source=${source} (${action}) for "${track.name}" by "${track.artist}"`
		);
		return true;
	}
}

export const spotifyAPI = new SpotifyAPI();
