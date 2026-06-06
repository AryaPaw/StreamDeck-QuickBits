import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import {
	spotifyLocalClient,
	spotifyState,
	SpotifyPlaybackState
} from "../shared/spotify";

const PLACEHOLDER_IMAGE = "imgs/actions/spotify/key";

const PLAY_OVERLAY = `<svg width="144" height="144" viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M72 120C98.5097 120 120 98.5097 120 72C120 45.4903 98.5097 24 72 24C45.4903 24 24 45.4903 24 72C24 98.5097 45.4903 120 72 120Z" fill="black" fill-opacity="0.6"/>
<path d="M58 50L96 72L58 94V50Z" fill="white"/>
</svg>
`;

@action({ UUID: "dev.aryapaw.quickbits.spotify-now-playing" })
export class SpotifyNowPlayingAction extends SingletonAction {
	private currentAction: WillAppearEvent["action"] | null = null;
	private unsubscribe: (() => void) | null = null;
	private lastTrackId: string | null = null;
	private cachedArtKey: string | null = null;
	private cachedOverlayImage: string | null = null;
	private cachedIsPlaying: boolean | null = null;

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.currentAction = ev.action;
		this.unsubscribe = spotifyState.subscribe((state) => this.onStateChange(state));
	}

	override async onWillDisappear(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const success = await spotifyLocalClient.togglePlayPause();
		if (!success) {
			await ev.action.showAlert();
		}
	}

	private async onStateChange(state: SpotifyPlaybackState): Promise<void> {
		if (!this.currentAction) return;

		const { track } = state;

		if (!track) {
			this.lastTrackId = null;
			this.cachedArtKey = null;
			this.cachedOverlayImage = null;
			this.cachedIsPlaying = null;
			await this.currentAction.setTitle("");
			await this.currentAction.setImage(PLACEHOLDER_IMAGE);
			return;
		}

		await this.currentAction.setTitle("");

		if (this.lastTrackId !== track.id) {
			this.lastTrackId = track.id;
			this.cachedArtKey = null;
			this.cachedOverlayImage = null;
			this.cachedIsPlaying = null;
		}

		const artPath = track.albumArtPath ? this.resolveArtPath(track.albumArtPath) : null;
		const artKey = `${track.id}:${artPath ?? track.albumArtBase64?.slice(0, 32) ?? ""}:${track.isPlaying}`;

		if (
			this.cachedArtKey === artKey &&
			this.cachedOverlayImage !== null &&
			this.cachedIsPlaying === track.isPlaying
		) {
			await this.currentAction.setImage(this.cachedOverlayImage);
			return;
		}

		if (!artPath && !track.albumArtBase64) {
			await this.currentAction.setImage(PLACEHOLDER_IMAGE);
			return;
		}

		try {
			const image = artPath
				? track.isPlaying
					? artPath
					: this.createOverlayImageFromPath(artPath)
				: this.createOverlayImage(
						track.albumArtBase64!,
						track.albumArtMime || "image/jpeg",
						track.isPlaying
					);

			this.cachedArtKey = artKey;
			this.cachedOverlayImage = image;
			this.cachedIsPlaying = track.isPlaying;
			await this.currentAction.setImage(image);
		} catch {
			if (artPath) {
				await this.currentAction.setImage(artPath);
			} else {
				await this.currentAction.setImage(PLACEHOLDER_IMAGE);
			}
		}
	}

	private resolveArtPath(pathOrRelative: string): string | null {
		if (existsSync(pathOrRelative)) {
			return pathOrRelative;
		}

		const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
		const absolute = join(pluginRoot, pathOrRelative);
		return existsSync(absolute) ? absolute : null;
	}

	private readArtAsBase64(artPath: string): string {
		const bytes = readFileSync(artPath);
		return bytes.toString("base64");
	}

	private createOverlayImageFromPath(artPath: string): string {
		const artBase64 = this.readArtAsBase64(artPath);
		return this.createOverlayImage(artBase64, "image/jpeg", false);
	}

	private createOverlayImage(base64Album: string, mimeType: string, isPlaying: boolean): string {
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
}
