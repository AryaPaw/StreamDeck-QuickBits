import { createHash } from "node:crypto";
import type { SpotifyTrack } from "../types";
import type { SpotifyLocalState } from "./types";

export function localTrackId(title: string): string {
	const normalized = title.trim().toLowerCase();
	return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

export function mapLocalStateToTrack(local: SpotifyLocalState): SpotifyTrack | null {
	const t = local.currentTrack;
	if (!local.isRunning || !t || !t.title.trim()) {
		return null;
	}

	const id = localTrackId(t.title);
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
