import { existsSync, readFileSync, statSync } from "node:fs";
import { resolveArtworkPath } from "./plugin-paths";

const PLAY_OVERLAY = `<svg width="144" height="144" viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M72 120C98.5097 120 120 98.5097 120 72C120 45.4903 98.5097 24 72 24C45.4903 24 24 45.4903 24 72C24 98.5097 45.4903 120 72 120Z" fill="black" fill-opacity="0.6"/>
<path d="M58 50L96 72L58 94V50Z" fill="white"/>
</svg>
`;

const pausedOverlayCache = new Map<string, string>();

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

function buildCompositeSvg(base64Album: string, mimeType: string, isPlaying: boolean): string {
	const overlayPart = isPlaying
		? ""
		: `<image xlink:href="data:image/svg+xml;base64,${Buffer.from(PLAY_OVERLAY).toString("base64")}" width="144" height="144"/>`;

	const compositeSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144" viewBox="0 0 144 144">
		<defs>
			<clipPath id="rounded">
				<rect width="144" height="144" rx="12"/>
			</clipPath>
		</defs>
		<image xlink:href="data:${mimeType};base64,${base64Album}" width="144" height="144" clip-path="url(#rounded)"/>
		${overlayPart}
	</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(compositeSvg).toString("base64")}`;
}

export function resolveTrackArtPath(pathOrRelative: string | undefined): string | null {
	if (!pathOrRelative) {
		return null;
	}

	return resolveArtworkPath(pathOrRelative);
}

export function buildPlayingImage(artPath: string): string | null {
	return isReadableArtFile(artPath) ? artPath : null;
}

export function buildPausedOverlay(artPath: string): string | null {
	const cached = pausedOverlayCache.get(artPath);
	if (cached) {
		return cached;
	}

	const base64 = readArtAsBase64(artPath);
	if (!base64) {
		return null;
	}

	const overlay = buildCompositeSvg(base64, "image/jpeg", false);
	pausedOverlayCache.set(artPath, overlay);
	return overlay;
}

export function buildOverlayFromBase64(
	base64Album: string,
	mimeType: string,
	isPlaying: boolean
): string {
	return buildCompositeSvg(base64Album, mimeType, isPlaying);
}

export function prebuildPausedOverlay(artPath: string): void {
	if (!pausedOverlayCache.has(artPath)) {
		buildPausedOverlay(artPath);
	}
}
