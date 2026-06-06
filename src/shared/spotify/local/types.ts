export type PlaybackStateName = "playing" | "paused" | "stopped" | "unknown";

export type SpotifyLocalState = {
	timestamp: string;
	isRunning: boolean;
	player: {
		state: PlaybackStateName;
		positionMs: number;
		durationMs: number;
	};
	currentTrack: {
		title: string;
		artist: string;
		album: string;
		sourceAppId: string;
		artworkBase64?: string;
		artworkMime?: string;
		artworkPath?: string;
	} | null;
	error?: string;
};

export type DaemonCommandName =
	| "getState"
	| "play"
	| "pause"
	| "togglePlayPause"
	| "next"
	| "previous"
	| "refreshArtwork"
	| "shutdown";

export type DaemonOutboundEvent =
	| { event: "ready"; filter: string; sessions: number }
	| { event: "state"; payload: SpotifyLocalState }
	| {
			event: "artwork";
			title: string;
			artist: string;
			album: string;
			artworkPath: string;
	  }
	| { event: "error"; message: string }
	| { event: "result"; id: number; ok: boolean; error?: string };

export type StateListener = (state: SpotifyLocalState) => void;
