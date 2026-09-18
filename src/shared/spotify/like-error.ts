import type { SpotifyLikeApiStatus } from "./types";

export type SpotifyGatewayError =
	| "geo_blocked"
	| "forbidden"
	| "no_access_token"
	| "daily"
	| "quota"
	| "blocked"
	| "timeout"
	| "fetch_failed"
	| "rate_limited"
	| "unknown";

export type LikeErrorBadge = "GEO" | "429" | "AUTH" | "403" | "NET" | "DAY" | "!";

export function isGeoBlockedBody(body: string): boolean {
	return /unavailable in this country/i.test(body);
}

export function parseGatewayError(error: string | null | undefined): SpotifyGatewayError {
	if (!error) {
		return "unknown";
	}
	if (error === "geo_blocked") {
		return "geo_blocked";
	}
	if (error === "forbidden") {
		return "forbidden";
	}
	if (error === "no_access_token" || error === "no access token" || /invalid_grant/i.test(error)) {
		return "no_access_token";
	}
	if (error === "daily") {
		return "daily";
	}
	if (error === "quota") {
		return "quota";
	}
	if (error === "rate_limited") {
		return "rate_limited";
	}
	if (error === "blocked" || error === "server blocked") {
		return "blocked";
	}
	if (error === "timeout" || error.startsWith("timeout")) {
		return "timeout";
	}
	if (error === "fetch_failed" || error.includes("fetch failed")) {
		return "fetch_failed";
	}
	return "unknown";
}

export function classifyGatewayFailure(
	error: string | null | undefined,
	httpStatus?: number
): SpotifyLikeApiStatus {
	if (httpStatus === 429) {
		return "rate_limited";
	}
	const parsed = parseGatewayError(error);
	if (parsed === "geo_blocked") {
		return "geo_blocked";
	}
	if (parsed === "rate_limited" || parsed === "blocked") {
		return "rate_limited";
	}
	if (parsed === "no_access_token") {
		return "no_auth";
	}
	if (httpStatus === 403 || parsed === "forbidden") {
		return "forbidden";
	}
	if (parsed === "timeout" || parsed === "fetch_failed") {
		return "net";
	}
	if (parsed === "daily") {
		return "daily";
	}
	return "unavailable";
}

export function likeApiStatusToBadge(status: SpotifyLikeApiStatus): LikeErrorBadge | null {
	switch (status) {
		case "ok":
			return null;
		case "geo_blocked":
			return "GEO";
		case "rate_limited":
			return "429";
		case "no_auth":
			return "AUTH";
		case "forbidden":
			return "403";
		case "net":
			return "NET";
		case "daily":
			return "DAY";
		case "unavailable":
			return "!";
		default: {
			const _never: never = status;
			return _never;
		}
	}
}

export function shouldShowLikeErrorBadge(
	status: SpotifyLikeApiStatus,
	known: boolean,
	pending: boolean
): boolean {
	if (pending || status === "ok") {
		return false;
	}
	switch (status) {
		case "no_auth":
		case "geo_blocked":
		case "forbidden":
		case "net":
		case "daily":
			return true;
		case "rate_limited":
		case "unavailable":
			return !known;
		default: {
			const _never: never = status;
			return _never;
		}
	}
}

export function probeLikeApiStatus(input: {
	hasRefreshToken: boolean;
	hasLikeCache: boolean;
	throttled: boolean;
	current: SpotifyLikeApiStatus;
}): SpotifyLikeApiStatus {
	if (!input.hasRefreshToken) {
		return "no_auth";
	}
	switch (input.current) {
		case "geo_blocked":
		case "forbidden":
		case "net":
		case "daily":
		case "no_auth":
			return input.current;
		case "ok":
		case "rate_limited":
		case "unavailable":
			break;
		default: {
			const _never: never = input.current;
			return _never;
		}
	}
	if (input.hasLikeCache) {
		return "ok";
	}
	if (input.throttled) {
		return "rate_limited";
	}
	return "ok";
}

export function resolveDisplayApiStatus(
	fetchStatus: SpotifyLikeApiStatus,
	hasCache: boolean
): SpotifyLikeApiStatus {
	switch (fetchStatus) {
		case "no_auth":
		case "geo_blocked":
		case "forbidden":
		case "net":
		case "daily":
			return fetchStatus;
		case "ok":
		case "rate_limited":
		case "unavailable":
			return hasCache ? "ok" : fetchStatus;
		default: {
			const _never: never = fetchStatus;
			return _never;
		}
	}
}

export function statusAfterSuccessfulLikeCache(current: SpotifyLikeApiStatus): SpotifyLikeApiStatus {
	switch (current) {
		case "geo_blocked":
		case "forbidden":
		case "net":
		case "daily":
		case "no_auth":
			return current;
		case "ok":
		case "rate_limited":
		case "unavailable":
			return "ok";
		default: {
			const _never: never = current;
			return _never;
		}
	}
}

export function mergePlaylistLikeStatus(
	globalStatus: SpotifyLikeApiStatus,
	localStatus: SpotifyLikeApiStatus
): SpotifyLikeApiStatus {
	switch (globalStatus) {
		case "no_auth":
		case "geo_blocked":
		case "net":
		case "daily":
		case "rate_limited":
			return globalStatus;
		case "ok":
		case "forbidden":
		case "unavailable":
			return localStatus !== "ok" ? localStatus : globalStatus;
		default: {
			const _never: never = globalStatus;
			return _never;
		}
	}
}

export function isGlobalLikeFailure(status: SpotifyLikeApiStatus): boolean {
	switch (status) {
		case "geo_blocked":
		case "no_auth":
		case "net":
		case "rate_limited":
		case "daily":
			return true;
		case "ok":
		case "forbidden":
		case "unavailable":
			return false;
		default: {
			const _never: never = status;
			return _never;
		}
	}
}
