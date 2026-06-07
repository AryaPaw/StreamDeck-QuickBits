export type SpotifySettings = {
	clientId?: string;
	clientSecret?: string;
	refreshToken?: string;
	accessToken?: string;
	tokenExpiry?: number;
};

export type SpotifyTrack = {
	id: string;
	uri: string;
	name: string;
	artist: string;
	album: string;
	albumArt?: string;
	albumArtBase64?: string;
	albumArtMime?: string;
	albumArtPath?: string;
	isPlaying: boolean;
	progress: number;
	duration: number;
};

export type SpotifyLikeApiStatus = "ok" | "no_auth" | "rate_limited" | "unavailable";

export type SpotifyPlaybackState = {
	track: SpotifyTrack | null;
	isLiked: boolean;
	likeApiStatus: SpotifyLikeApiStatus;
};

export type SpotifyPlayingItem = {
	type?: string;
	id: string;
	uri: string;
	name: string;
	duration_ms: number;
	artists?: { name: string }[];
	album?: { name: string; images?: { url: string }[] };
	show?: { name: string; publisher?: string; images?: { url: string }[] };
};

export type SpotifyCurrentlyPlaying = {
	is_playing: boolean;
	progress_ms: number;
	item: SpotifyPlayingItem | null;
};

export type StateListener = (state: SpotifyPlaybackState) => void;
