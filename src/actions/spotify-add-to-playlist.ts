import streamDeck, {
	action,
	DidReceiveSettingsEvent,
	KeyDownEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";
import { KeyPressGuard } from "../shared/key-press-guard";
import {
	getSpotifySettings,
	loadSpotifySettings,
	spotifyAPI,
	spotifyState,
	SpotifyPlaybackState
} from "../shared/spotify";
import { hasGrantedScopes, PLAYLIST_REQUIRED_SCOPES } from "../shared/spotify/auth";
import { spotifyApiGateway } from "../shared/spotify/api-gateway";
import { buildPlaylistLikeKeyImage } from "../shared/spotify/playlist-like-key";
import {
	classifyGatewayFailure,
	isGlobalLikeFailure,
	likeApiStatusToBadge,
	mergePlaylistLikeStatus,
	shouldShowLikeErrorBadge
} from "../shared/spotify/like-error";
import type { SpotifyLikeApiStatus } from "../shared/spotify/types";

export type SpotifyAddToPlaylistSettings = {
	playlistId?: string;
	playlistName?: string;
};

type PiMessage = {
	event?: string;
	playlistId?: string;
	playlistName?: string;
};

type VisibleKey = {
	action: WillAppearEvent<SpotifyAddToPlaylistSettings>["action"];
	settings: SpotifyAddToPlaylistSettings;
	inPlaylist: boolean;
	known: boolean;
	pending: boolean;
	apiStatus: SpotifyLikeApiStatus;
	renderSerial: number;
};

@action({ UUID: "dev.aryapaw.quickbits.spotify-add-to-playlist" })
export class SpotifyAddToPlaylistAction extends SingletonAction<SpotifyAddToPlaylistSettings> {
	private readonly keyPressGuard = new KeyPressGuard();
	private readonly visible = new Map<string, VisibleKey>();
	private unsubscribe: (() => void) | null = null;
	private lastTrackId: string | null = null;

	override async onWillAppear(ev: WillAppearEvent<SpotifyAddToPlaylistSettings>): Promise<void> {
		await loadSpotifySettings();
		this.visible.set(ev.action.id, {
			action: ev.action,
			settings: ev.payload.settings,
			inPlaylist: false,
			known: false,
			pending: false,
			apiStatus: "ok",
			renderSerial: 0
		});
		if (!this.unsubscribe) {
			this.unsubscribe = spotifyState.subscribe((state) => {
				void this.onPlaybackState(state);
			});
		}
		await this.renderKey(ev.action.id);
		void this.ensurePlaylistName(ev.action.id);
		void this.refreshMembership(ev.action.id);
	}

	override async onWillDisappear(ev: WillDisappearEvent<SpotifyAddToPlaylistSettings>): Promise<void> {
		this.visible.delete(ev.action.id);
		if (this.visible.size === 0) {
			this.unsubscribe?.();
			this.unsubscribe = null;
		}
	}

	override async onDidReceiveSettings(
		ev: DidReceiveSettingsEvent<SpotifyAddToPlaylistSettings>
	): Promise<void> {
		const next = ev.payload.settings;
		const entry = this.visible.get(ev.action.id);
		const previousId = entry?.settings.playlistId?.trim() || "";
		const previousName = entry?.settings.playlistName?.trim() || "";
		const nextId = next.playlistId?.trim() || "";
		const nextName = next.playlistName?.trim() || "";
		const idChanged = previousId !== nextId;
		const nameStale = idChanged && (!nextName || nextName === previousName);

		if (previousId && idChanged) {
			spotifyAPI.forgetPlaylistCache(previousId);
		}

		const resolved: SpotifyAddToPlaylistSettings = {
			playlistId: nextId,
			playlistName: nameStale ? undefined : nextName
		};

		if (entry) {
			entry.settings = resolved;
			entry.known = false;
			entry.inPlaylist = false;
			entry.pending = false;
			entry.apiStatus = "ok";
		}

		await this.renderKey(ev.action.id);
		void this.ensurePlaylistName(ev.action.id, nameStale);
		void this.refreshMembership(ev.action.id);
	}

	override async onSendToPlugin(
		ev: SendToPluginEvent<PiMessage, SpotifyAddToPlaylistSettings>
	): Promise<void> {
		const eventName = ev.payload.event;
		if (eventName === "playlists" || eventName === "refreshPlaylists") {
			await this.sendPlaylistsToPi();
			return;
		}
		if (eventName === "selectPlaylist") {
			const playlistId = ev.payload.playlistId?.trim() ?? "";
			const playlistName = ev.payload.playlistName?.trim() ?? "";
			const previousId = (await ev.action.getSettings()).playlistId;
			if (previousId && previousId !== playlistId) {
				spotifyAPI.forgetPlaylistCache(previousId);
			}
			await ev.action.setSettings({ playlistId, playlistName });
		}
	}

	override async onKeyDown(ev: KeyDownEvent<SpotifyAddToPlaylistSettings>): Promise<void> {
		await this.keyPressGuard.run(ev.action.id, async () => {
			await loadSpotifySettings();
			const settings = getSpotifySettings();
			if (!settings.refreshToken) {
				await ev.action.showAlert();
				return;
			}

			const actionSettings = await ev.action.getSettings();
			const playlistId = actionSettings.playlistId?.trim();
			const playlistName = actionSettings.playlistName?.trim() || "playlist";
			if (!playlistId) {
				await ev.action.showAlert();
				return;
			}

			const track = spotifyState.getState().track;
			if (!track) {
				await ev.action.showAlert();
				return;
			}

			const entry = this.visible.get(ev.action.id);
			const previous = entry?.inPlaylist ?? false;
			if (entry) {
				entry.pending = true;
			}
			await this.renderKey(ev.action.id);

			const result = await spotifyAPI.toggleCurrentTrackInPlaylist(
				settings,
				track,
				playlistId,
				playlistName
			);
			if (entry) {
				entry.pending = false;
			}
			if (!result.ok) {
				if (entry) {
					entry.inPlaylist = previous;
					this.applyPlaylistFailure(entry);
				}
				if (spotifyApiGateway.getLastError() === "geo_blocked") {
					streamDeck.logger.warn(
						"[Spotify] Playlist like blocked by geo/VPN - fix network exit country, then retry"
					);
				}
				await this.renderKey(ev.action.id);
				await ev.action.showAlert();
				return;
			}

			if (entry) {
				entry.inPlaylist = result.inPlaylist;
				entry.known = true;
				entry.apiStatus = "ok";
			}
			await this.renderKey(ev.action.id);
		});
	}

	private async onPlaybackState(state: SpotifyPlaybackState): Promise<void> {
		const trackId = state.track?.id ?? null;
		const trackChanged = trackId !== this.lastTrackId;
		this.lastTrackId = trackId;
		for (const contextId of this.visible.keys()) {
			const entry = this.visible.get(contextId);
			if (!entry) {
				continue;
			}
			if (trackChanged) {
				entry.pending = false;
			}
			const playlistId = entry.settings.playlistId?.trim();
			const peek =
				state.track && playlistId
					? spotifyAPI.peekTrackInPlaylist(playlistId, state.track)
					: null;
			if (peek !== null) {
				entry.inPlaylist = peek;
				entry.known = true;
			} else if (trackChanged) {
				entry.known = false;
			}
			await this.renderKey(contextId);
			if (trackChanged) {
				void this.refreshMembership(contextId);
			}
		}
	}

	private async refreshMembership(contextId: string): Promise<void> {
		const entry = this.visible.get(contextId);
		if (!entry || entry.pending) {
			return;
		}
		const playlistId = entry.settings.playlistId?.trim();
		if (!playlistId) {
			return;
		}

		await loadSpotifySettings();
		const settings = getSpotifySettings();
		if (
			!settings.refreshToken ||
			(settings.oauthScopes && !hasGrantedScopes(settings.oauthScopes, PLAYLIST_REQUIRED_SCOPES))
		) {
			entry.apiStatus = "no_auth";
			await this.renderKey(contextId);
			return;
		}

		const track = spotifyState.getState().track;
		if (!track) {
			entry.known = true;
			entry.inPlaylist = false;
			await this.renderKey(contextId);
			return;
		}

		const inPlaylist = await spotifyAPI.isCurrentTrackInPlaylist(settings, track, playlistId);
		if (!this.visible.has(contextId)) {
			return;
		}
		const latest = this.visible.get(contextId);
		if (!latest || latest.pending) {
			return;
		}
		if (inPlaylist === null) {
			this.applyPlaylistFailure(latest);
			await this.renderKey(contextId);
			return;
		}
		latest.inPlaylist = inPlaylist;
		latest.known = true;
		latest.apiStatus = "ok";
		await this.renderKey(contextId);
	}

	private async ensurePlaylistName(contextId: string, force = false): Promise<void> {
		const entry = this.visible.get(contextId);
		if (!entry) {
			return;
		}
		const playlistId = entry.settings.playlistId?.trim();
		if (!playlistId || (!force && entry.settings.playlistName?.trim())) {
			return;
		}

		await loadSpotifySettings();
		const settings = getSpotifySettings();
		if (!settings.refreshToken) {
			return;
		}

		const name = await spotifyAPI.fetchPlaylistName(settings, playlistId);
		if (!name || !this.visible.has(contextId)) {
			return;
		}
		if (entry.settings.playlistId?.trim() !== playlistId) {
			return;
		}
		entry.settings = { playlistId, playlistName: name };
		await entry.action.setSettings(entry.settings);
		await this.renderKey(contextId);
	}

	private playlistTitle(settings: SpotifyAddToPlaylistSettings): string {
		const name = settings.playlistName?.trim();
		if (!name) {
			return settings.playlistId?.trim() ? "Playlist" : "Choose";
		}
		return name;
	}

	private async renderKey(contextId: string): Promise<void> {
		const entry = this.visible.get(contextId);
		if (!entry) {
			return;
		}

		const serial = ++entry.renderSerial;
		const title = this.playlistTitle(entry.settings);
		await entry.action.setTitle("");
		if (serial !== entry.renderSerial) {
			return;
		}

		const settings = getSpotifySettings();
		const state = spotifyState.getState();
		const playlistId = entry.settings.playlistId?.trim();
		const localStatus = !settings.refreshToken ? "no_auth" : entry.apiStatus;
		const status = mergePlaylistLikeStatus(state.likeApiStatus, localStatus);
		const badge = likeApiStatusToBadge(status);
		const showError = shouldShowLikeErrorBadge(status, entry.known, entry.pending);

		const visual = showError
			? "unavailable"
			: entry.pending
				? "pending"
				: entry.inPlaylist && playlistId
					? "liked"
					: "empty";

		await entry.action.setImage(
			buildPlaylistLikeKeyImage(title, visual, showError ? (badge ?? "!") : undefined)
		);
	}

	private applyPlaylistFailure(entry: VisibleKey): void {
		const status = classifyGatewayFailure(spotifyApiGateway.getLastError());
		entry.apiStatus = status;
		if (isGlobalLikeFailure(status)) {
			spotifyState.markLikeApiFailure(status);
		}
	}

	private async sendPlaylistsToPi(): Promise<void> {
		const send = (payload: {
			event: "playlists";
			ok: boolean;
			items: Array<{ value: string; label: string }>;
			error?: string;
			playlists?: Array<{ id: string; name: string }>;
		}): void => {
			void streamDeck.ui.sendToPropertyInspector(payload);
		};

		await loadSpotifySettings();
		const settings = getSpotifySettings();
		if (!settings.refreshToken) {
			send({
				event: "playlists",
				ok: false,
				items: [],
				error: "Not connected - open Spotify Setup and authorize"
			});
			return;
		}

		if (settings.oauthScopes && !hasGrantedScopes(settings.oauthScopes, PLAYLIST_REQUIRED_SCOPES)) {
			streamDeck.logger.info(
				`[Spotify] Playlist scopes missing (granted=${settings.oauthScopes ?? "unknown"}) - re-authorize with show_dialog`
			);
			send({
				event: "playlists",
				ok: false,
				items: [],
				error:
					"Need playlist permission. Open Spotify Setup and Authorize again - accept the new playlist checkboxes."
			});
			return;
		}

		const playlists = await spotifyAPI.listWritablePlaylists(settings);
		if (!playlists) {
			const err = spotifyApiGateway.getLastError();
			const message =
				err === "geo_blocked"
					? "Spotify unavailable in this country (VPN/proxy)"
					: err === "forbidden"
						? "Need playlist permission. Open Spotify Setup and Authorize again - accept the new playlist checkboxes."
						: "Failed to load playlists";
			send({
				event: "playlists",
				ok: false,
				items: [],
				error: message
			});
			return;
		}

		send({
			event: "playlists",
			ok: true,
			playlists,
			items: playlists.map((playlist) => ({
				value: playlist.id,
				label: playlist.name
			}))
		});
	}
}
