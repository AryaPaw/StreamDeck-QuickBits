import { describe, expect, test } from "bun:test";
import {
	classifyGatewayFailure,
	likeApiStatusToBadge,
	mergePlaylistLikeStatus,
	probeLikeApiStatus,
	resolveDisplayApiStatus,
	shouldShowLikeErrorBadge,
	statusAfterSuccessfulLikeCache
} from "../src/shared/spotify/like-error";

describe("classifyGatewayFailure", () => {
	test("maps gateway errors to like statuses", () => {
		expect(classifyGatewayFailure("geo_blocked")).toBe("geo_blocked");
		expect(classifyGatewayFailure(null, 429)).toBe("rate_limited");
		expect(classifyGatewayFailure("rate_limited")).toBe("rate_limited");
		expect(classifyGatewayFailure("blocked")).toBe("rate_limited");
		expect(classifyGatewayFailure("no access token")).toBe("no_auth");
		expect(classifyGatewayFailure("no_access_token")).toBe("no_auth");
		expect(classifyGatewayFailure("invalid_grant")).toBe("no_auth");
		expect(classifyGatewayFailure("forbidden")).toBe("forbidden");
		expect(classifyGatewayFailure("unknown", 403)).toBe("forbidden");
		expect(classifyGatewayFailure("timeout after 12000ms")).toBe("net");
		expect(classifyGatewayFailure("fetch failed")).toBe("net");
		expect(classifyGatewayFailure("fetch_failed")).toBe("net");
		expect(classifyGatewayFailure("daily")).toBe("daily");
		expect(classifyGatewayFailure("quota")).toBe("unavailable");
		expect(classifyGatewayFailure("unknown")).toBe("unavailable");
		expect(classifyGatewayFailure(null)).toBe("unavailable");
	});
});

describe("likeApiStatusToBadge", () => {
	test("maps statuses to key badges", () => {
		expect(likeApiStatusToBadge("ok")).toBeNull();
		expect(likeApiStatusToBadge("geo_blocked")).toBe("GEO");
		expect(likeApiStatusToBadge("rate_limited")).toBe("429");
		expect(likeApiStatusToBadge("no_auth")).toBe("AUTH");
		expect(likeApiStatusToBadge("forbidden")).toBe("403");
		expect(likeApiStatusToBadge("net")).toBe("NET");
		expect(likeApiStatusToBadge("daily")).toBe("DAY");
		expect(likeApiStatusToBadge("unavailable")).toBe("!");
	});
});

describe("probeLikeApiStatus", () => {
	test("does not wipe geo when a like cache exists", () => {
		expect(
			probeLikeApiStatus({
				hasRefreshToken: true,
				hasLikeCache: true,
				throttled: false,
				current: "geo_blocked"
			})
		).toBe("geo_blocked");
	});

	test("returns ok from cache when current status is not sticky", () => {
		expect(
			probeLikeApiStatus({
				hasRefreshToken: true,
				hasLikeCache: true,
				throttled: true,
				current: "unavailable"
			})
		).toBe("ok");
	});

	test("returns no_auth without a refresh token", () => {
		expect(
			probeLikeApiStatus({
				hasRefreshToken: false,
				hasLikeCache: true,
				throttled: false,
				current: "ok"
			})
		).toBe("no_auth");
	});
});

describe("resolveDisplayApiStatus", () => {
	test("keeps geo and auth even with cache", () => {
		expect(resolveDisplayApiStatus("geo_blocked", true)).toBe("geo_blocked");
		expect(resolveDisplayApiStatus("no_auth", true)).toBe("no_auth");
		expect(resolveDisplayApiStatus("rate_limited", true)).toBe("ok");
		expect(resolveDisplayApiStatus("unavailable", true)).toBe("ok");
		expect(resolveDisplayApiStatus("net", true)).toBe("net");
	});
});

describe("statusAfterSuccessfulLikeCache", () => {
	test("preserves sticky failures", () => {
		expect(statusAfterSuccessfulLikeCache("geo_blocked")).toBe("geo_blocked");
		expect(statusAfterSuccessfulLikeCache("rate_limited")).toBe("ok");
	});
});

describe("shouldShowLikeErrorBadge", () => {
	test("hides 429 when like is known", () => {
		expect(shouldShowLikeErrorBadge("rate_limited", true, false)).toBe(false);
		expect(shouldShowLikeErrorBadge("rate_limited", false, false)).toBe(true);
		expect(shouldShowLikeErrorBadge("geo_blocked", true, false)).toBe(true);
		expect(shouldShowLikeErrorBadge("geo_blocked", true, true)).toBe(false);
	});
});

describe("mergePlaylistLikeStatus", () => {
	test("keeps playlist 403 off the global like path", () => {
		expect(mergePlaylistLikeStatus("ok", "forbidden")).toBe("forbidden");
		expect(mergePlaylistLikeStatus("geo_blocked", "forbidden")).toBe("geo_blocked");
		expect(mergePlaylistLikeStatus("unavailable", "ok")).toBe("unavailable");
	});
});
