import { existsSync, readFileSync, statSync } from "node:fs";
import { resolveArtworkPath } from "./plugin-paths";
import type { SpotifyTrack } from "./types";

const PLAY_ICON_INNER = `<path d="M54 40l52 32-52 32V40z"/>`;
const PAUSE_OVERLAY = `<circle fill="#131313" opacity="0.7" fill-rule="nonzero" cx="72" cy="72" r="58"/><g fill="white">${PLAY_ICON_INNER}</g>`;

const keyImageCache = new Map<string, string>();

function isReadableArtFile(artPath: string): boolean {
	if (!existsSync(artPath)) {
		return false;
	}

	try {
		return statSync(artPath).size > 0;
	} catch {
		return false;
	}
}

function readArtAsBase64(artPath: string): string | null {
	if (!isReadableArtFile(artPath)) {
		return null;
	}

	try {
		return readFileSync(artPath).toString("base64");
	} catch {
		return null;
	}
}

function buildKeySvg(base64Album: string, mimeType: string, isPlaying: boolean): string {
	const overlayPart = isPlaying ? "" : PAUSE_OVERLAY;

	const compositeSvg = `<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<image x="0" y="0" width="144" height="144" xlink:href="data:${mimeType};base64,${base64Album}"/>
${overlayPart}
</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(compositeSvg).toString("base64")}`;
}

function artSourceKey(track: SpotifyTrack): string | null {
	const artPath = resolveTrackArtPath(track.albumArtPath);
	if (artPath) {
		return artPath;
	}

	if (track.albumArtBase64) {
		return `b64:${track.albumArtBase64.slice(0, 48)}`;
	}

	return null;
}

export function resolveTrackArtPath(pathOrRelative: string | undefined): string | null {
	if (!pathOrRelative) {
		return null;
	}

	return resolveArtworkPath(pathOrRelative);
}

export function buildNowPlayingKeyImage(track: SpotifyTrack, isPlaying: boolean): string | null {
	const sourceKey = artSourceKey(track);
	if (!sourceKey) {
		return null;
	}

	const cacheKey = `${sourceKey}:${isPlaying}`;
	const cached = keyImageCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const artPath = resolveTrackArtPath(track.albumArtPath);
	let base64: string | null = null;
	let mimeType = track.albumArtMime || "image/jpeg";

	if (artPath) {
		base64 = readArtAsBase64(artPath);
	}

	if (!base64 && track.albumArtBase64) {
		base64 = track.albumArtBase64;
		mimeType = track.albumArtMime || "image/jpeg";
	}

	if (!base64) {
		return null;
	}

	const image = buildKeySvg(base64, mimeType, isPlaying);
	keyImageCache.set(cacheKey, image);

	if (keyImageCache.size > 80) {
		const oldest = keyImageCache.keys().next().value;
		if (oldest) {
			keyImageCache.delete(oldest);
		}
	}

	return image;
}
