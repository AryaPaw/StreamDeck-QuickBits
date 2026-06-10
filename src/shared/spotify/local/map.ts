import { createHash } from "node:crypto";
import type { SpotifyTrack } from "../types";
import type { SpotifyLocalState } from "./types";

export function normalizeTrackTitle(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/[\u201c\u201d\u2018\u2019"']/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function normalizeArtistKey(artist: string): string {
	const primary = artist.trim().split(/[,;&]| feat\.?| ft\.?/i)[0]?.trim() ?? "";
	return primary.toLowerCase();
}

export function isSameTrackTitle(a: string, b: string): boolean {
	return normalizeTrackTitle(a) === normalizeTrackTitle(b);
}

export function normalizeAlbumKey(album: string): string {
	return album
		.trim()
		.toLowerCase()
		.replace(/[\u201c\u201d\u2018\u2019"']/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function isSameAlbumName(a: string, b: string): boolean {
	const left = normalizeAlbumKey(a);
	const right = normalizeAlbumKey(b);
	if (!left || !right) {
		return false;
	}
	return left === right || left.includes(right) || right.includes(left);
}

export function artistMatchesGsmtc(artistNames: string[], expected: string): boolean {
	if (!expected || expected === "Unknown") {
		return true;
	}

	const parts = expected
		.toLowerCase()
		.split(/[,;&]| feat\.?| ft\.?/i)
		.map((part) => part.trim())
		.filter(Boolean);

	return artistNames.some((name) => {
		const lower = name.toLowerCase();
		return parts.some((part) => lower.includes(part) || part.includes(lower));
	});
}

export type PlayerTrackMetadata = {
	name: string;
	artists: string;
	album?: string;
};

export function metadataMatchesPlayer(track: SpotifyTrack, player: PlayerTrackMetadata): boolean {
	const titleMatch =
		isSameTrackTitle(track.name, player.name) ||
		normalizeTrackTitle(track.name).includes(normalizeTrackTitle(player.name)) ||
		normalizeTrackTitle(player.name).includes(normalizeTrackTitle(track.name));

	if (!titleMatch) {
		return false;
	}

	const playerArtists = player.artists
		.split(/[,;&]| feat\.?| ft\.?/i)
		.map((part) => part.trim())
		.filter(Boolean);

	return artistMatchesGsmtc(playerArtists.length > 0 ? playerArtists : [player.artists], track.artist);
}

function pickArtist(current: string, previous: string): string {
	const currentTrimmed = current.trim();
	if (currentTrimmed && currentTrimmed !== "Unknown") {
		return currentTrimmed;
	}
	const previousTrimmed = previous.trim();
	if (previousTrimmed && previousTrimmed !== "Unknown") {
		return previousTrimmed;
	}
	return currentTrimmed || previousTrimmed || "Unknown";
}

export function localTrackId(title: string, artist = ""): string {
	const normalized = `${normalizeTrackTitle(title)}\0${normalizeArtistKey(artist)}`;
	return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

export function stabilizeTrackIdentity(
	incoming: SpotifyTrack,
	previous: SpotifyTrack | null
): SpotifyTrack {
	if (!previous || !isSameTrackTitle(incoming.name, previous.name)) {
		return incoming;
	}

	return {
		...incoming,
		id: previous.id,
		artist: pickArtist(incoming.artist, previous.artist),
		album: incoming.album || previous.album,
		albumArtPath: incoming.albumArtPath ?? previous.albumArtPath,
		albumArtBase64: incoming.albumArtBase64 ?? previous.albumArtBase64,
		albumArtMime: incoming.albumArtMime ?? previous.albumArtMime
	};
}

export function mapLocalStateToTrack(local: SpotifyLocalState): SpotifyTrack | null {
	const t = local.currentTrack;
	if (!local.isRunning || !t || !t.title.trim()) {
		return null;
	}

	const id = localTrackId(t.title, t.artist || "");
	const isPlaying = local.player.state === "playing";

	return {
		id,
		uri: `local:${id}`,
		name: t.title,
		artist: t.artist || "Unknown",
		album: t.album || "",
		albumArtBase64: t.artworkBase64,
		albumArtMime: t.artworkMime,
		albumArtPath: t.artworkPath,
		isPlaying,
		progress: local.player.positionMs,
		duration: local.player.durationMs
	};
}
