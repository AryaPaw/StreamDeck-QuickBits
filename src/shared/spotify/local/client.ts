import { spotifyLocalDaemon } from "./daemon";
import type { SpotifyLocalState } from "./types";

class SpotifyLocalClient {
	togglePlayPause(): Promise<boolean> {
		return spotifyLocalDaemon.sendCommand("togglePlayPause");
	}

	next(): Promise<boolean> {
		return spotifyLocalDaemon.sendCommand("next");
	}

	previous(): Promise<boolean> {
		return spotifyLocalDaemon.sendCommand("previous");
	}

	refreshArtwork(): Promise<boolean> {
		return spotifyLocalDaemon.sendCommand("refreshArtwork");
	}

	wasRecentSkipTransport(withinMs?: number): boolean {
		return spotifyLocalDaemon.wasRecentSkipTransport(withinMs);
	}

	subscribe(listener: (state: SpotifyLocalState) => void): () => void {
		return spotifyLocalDaemon.subscribe(listener);
	}
}

export const spotifyLocalClient = new SpotifyLocalClient();
