import streamDeck from "@elgato/streamdeck";
import { spotifyAuth } from "./auth";
import { spotifyApiMetrics, type ApiTrackContext } from "./api-metrics";
import { SPOTIFY_WEB_API_LIMITS } from "./limits";
import { spotifyRateLimit } from "./rate-limit";
import type { SpotifySettings } from "./types";

export type ApiRequestPriority = "manual" | "normal" | "background";

export type ApiGatewayOptions = {
	method?: "GET" | "PUT" | "DELETE" | "POST";
	headers?: Record<string, string>;
	body?: string;
	priority?: ApiRequestPriority;
	reason?: string;
	bypassQuota?: boolean;
	/** @deprecated use bypassQuota */
	bypassLibraryThrottle?: boolean;
	track?: ApiTrackContext;
};

function endpointBucket(url: string): "search" | "library" {
	return url.includes("/search") ? "search" : "library";
}

function endpointLabel(url: string): string {
	try {
		const u = new URL(url);
		return u.pathname;
	} catch {
		return url;
	}
}

const REQUEST_TIMEOUT_MS = 12_000;

function isGeoBlockedBody(body: string): boolean {
	return /unavailable in this country/i.test(body);
}

function isPlaylistEndpointForbidden(url: string, body: string): boolean {
	return url.includes("/playlists/") && /"message"\s*:\s*"Forbidden"/i.test(body);
}

class SpotifyApiGateway {
	private requestTimestamps: number[] = [];
	private inflight = new Map<string, Promise<Response | null>>();
	private dailyRequestCount = 0;
	private dailyRequestDayKey = "";
	private dailySoftStopLogged = false;
	private lastError: string | null = null;

	getLastError(): string | null {
		return this.lastError;
	}

	private setLastError(message: string): void {
		this.lastError = message.includes("fetch failed") ? "fetch failed" : message;
	}

	private clearLastError(): void {
		this.lastError = null;
	}

	resetLastError(): void {
		this.clearLastError();
	}

	private trimWindow(): void {
		const cutoff = Date.now() - SPOTIFY_WEB_API_LIMITS.windowMs;
		while (this.requestTimestamps.length > 0 && this.requestTimestamps[0]! < cutoff) {
			this.requestTimestamps.shift();
		}
	}

	private countInWindow(): number {
		this.trimWindow();
		return this.requestTimestamps.length;
	}

	private recordQuotaUse(): void {
		this.requestTimestamps.push(Date.now());
	}

	private isQuotaExceeded(): boolean {
		return this.countInWindow() >= spotifyRateLimit.getRequestLimit();
	}

	getRollingCounts(): { total: number; limit: number } {
		return {
			total: this.countInWindow(),
			limit: spotifyRateLimit.getRequestLimit()
		};
	}

	getDailyRequestCount(): { count: number; limit: number } {
		this.trimDailyCounter();
		return {
			count: this.dailyRequestCount,
			limit: SPOTIFY_WEB_API_LIMITS.dailyBackgroundLimit
		};
	}

	/** True when soft daily budget is exhausted - background like-sync should pause */
	isDailyBackgroundBudgetExhausted(): boolean {
		return this.isDailySoftStopActive();
	}

	private dailyKey(): string {
		const now = new Date();
		return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
	}

	private trimDailyCounter(): void {
		const key = this.dailyKey();
		if (key !== this.dailyRequestDayKey) {
			this.dailyRequestDayKey = key;
			this.dailyRequestCount = 0;
			this.dailySoftStopLogged = false;
		}
	}

	private recordDailyRequest(options: ApiGatewayOptions): void {
		this.trimDailyCounter();
		// Manual / bypass requests do not consume the soft background budget
		if (this.shouldBypassQuota(options)) {
			return;
		}
		this.dailyRequestCount += 1;
		const limit = SPOTIFY_WEB_API_LIMITS.dailyBackgroundLimit;
		if (this.dailyRequestCount === SPOTIFY_WEB_API_LIMITS.dailyBackgroundWarnAt) {
			streamDeck.logger.warn(
				`[Spotify] Daily background Web API usage at ${this.dailyRequestCount}/${limit} (manual Like still allowed)`
			);
		}
		if (this.dailyRequestCount === limit && !this.dailySoftStopLogged) {
			this.dailySoftStopLogged = true;
			streamDeck.logger.warn(
				`[Spotify] Daily background API budget exhausted (${limit}) - like sync paused until midnight; manual Like still works`
			);
		}
	}

	private isDailySoftStopActive(): boolean {
		this.trimDailyCounter();
		return this.dailyRequestCount >= SPOTIFY_WEB_API_LIMITS.dailyBackgroundLimit;
	}

	private shouldBypassQuota(options: ApiGatewayOptions): boolean {
		return (
			options.bypassQuota === true ||
			options.bypassLibraryThrottle === true ||
			options.priority === "manual"
		);
	}

	private shouldBlockProactive(options: ApiGatewayOptions): "blocked" | "quota" | "daily" | null {
		// Hard stop: respect Spotify Retry-After even for manual (avoid hammering while banned)
		if (spotifyRateLimit.shouldThrottle()) {
			return "blocked";
		}

		if (this.shouldBypassQuota(options)) {
			return null;
		}

		// Soft daily: only background / normal sync is paused
		if (this.isDailySoftStopActive()) {
			return "daily";
		}

		if (this.isQuotaExceeded()) {
			return "quota";
		}

		return null;
	}

	async request(
		settings: SpotifySettings,
		url: string,
		options: ApiGatewayOptions = {}
	): Promise<Response | null> {
		const method = options.method ?? "GET";
		const bucket = endpointBucket(url);
		const endpoint = endpointLabel(url);
		const reason = options.reason ?? "unknown";
		const dedupeKey = `${method}:${url}`;

		this.clearLastError();

		const blockReason = this.shouldBlockProactive(options);
		if (blockReason) {
			this.setLastError(blockReason === "blocked" ? "server blocked" : blockReason);
			spotifyApiMetrics.record({
				kind: blockReason === "quota" || blockReason === "daily" ? "skipped" : "blocked",
				bucket,
				method,
				endpoint,
				reason: `${reason}:${blockReason}`,
				track: options.track
			});
			streamDeck.logger.debug(
				`[Spotify] API ${blockReason} ${method} ${endpoint} (${reason})`
			);
			return null;
		}

		if (method === "GET") {
			const existing = this.inflight.get(dedupeKey);
			if (existing) {
				spotifyApiMetrics.record({
					kind: "cache_hit",
					bucket,
					method,
					endpoint,
					reason: "dedupe-inflight",
					track: options.track
				});
				const shared = await existing;
				return shared ? shared.clone() : null;
			}
		}

		const promise = this.executeRequest(settings, url, {
			...options,
			method,
			reason,
			bucket,
			endpoint
		});
		if (method === "GET") {
			this.inflight.set(dedupeKey, promise);
		}
		try {
			const shared = await promise;
			return shared ? shared.clone() : null;
		} finally {
			if (method === "GET" && this.inflight.get(dedupeKey) === promise) {
				this.inflight.delete(dedupeKey);
			}
		}
	}

	private async executeRequest(
		settings: SpotifySettings,
		url: string,
		ctx: ApiGatewayOptions & {
			method: string;
			reason: string;
			bucket: "search" | "library";
			endpoint: string;
		}
	): Promise<Response | null> {
		this.recordQuotaUse();
		this.recordDailyRequest(ctx);

		spotifyApiMetrics.record({
			kind: "request",
			bucket: ctx.bucket,
			method: ctx.method,
			endpoint: ctx.endpoint,
			reason: ctx.reason,
			track: ctx.track
		});

		streamDeck.logger.debug(`[Spotify] API ${ctx.method} ${ctx.endpoint} reason=${ctx.reason}`);

		let token = await spotifyAuth.ensureAccessToken(settings);
		if (!token) {
			this.setLastError("no access token");
			return null;
		}

		const doFetch = async (authToken: string): Promise<Response> => {
			const headers = { ...(ctx.headers ?? {}), Authorization: `Bearer ${authToken}` };
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			try {
				return await fetch(url, {
					method: ctx.method,
					headers,
					body: ctx.body,
					signal: controller.signal
				});
			} finally {
				clearTimeout(timeout);
			}
		};

		try {
			let response = await doFetch(token);
			if (response.status === 401) {
				streamDeck.logger.info(
					`[Spotify] API 401 on ${ctx.endpoint} (${ctx.reason}) - forcing token refresh`
				);
				token = await spotifyAuth.ensureAccessToken(settings, true);
				if (!token) {
					this.setLastError("no access token");
					return null;
				}
				response = await doFetch(token);
			} else if (response.status === 403) {
				const body = await response.clone().text().catch(() => "");
				if (isGeoBlockedBody(body)) {
					this.setLastError("geo_blocked");
					streamDeck.logger.warn(
						`[Spotify] API geo-blocked on ${ctx.endpoint} (${ctx.reason}): Spotify unavailable in this country`
					);
					return response;
				}
				if (isPlaylistEndpointForbidden(url, body)) {
					this.setLastError("forbidden");
					streamDeck.logger.warn(
						`[Spotify] API 403 on ${ctx.endpoint} (${ctx.reason}) - not refreshing token`
					);
					return response;
				}
				streamDeck.logger.info(
					`[Spotify] API 403 on ${ctx.endpoint} (${ctx.reason}) - forcing token refresh`
				);
				token = await spotifyAuth.ensureAccessToken(settings, true);
				if (!token) {
					this.setLastError("no access token");
					return null;
				}
				response = await doFetch(token);
				if (response.status === 403) {
					const retryBody = await response.clone().text().catch(() => "");
					if (isGeoBlockedBody(retryBody)) {
						this.setLastError("geo_blocked");
						streamDeck.logger.warn(
							`[Spotify] API geo-blocked on ${ctx.endpoint} after refresh (${ctx.reason})`
						);
					} else {
						this.setLastError("forbidden");
					}
				}
			}

			if (response.status === 429) {
				spotifyRateLimit.record429(url, response);
				spotifyApiMetrics.record({
					kind: "429",
					bucket: ctx.bucket,
					method: ctx.method,
					endpoint: ctx.endpoint,
					reason: ctx.reason,
					status: 429,
					track: ctx.track
				});
				return response;
			}

			if (response.ok || response.status === 204) {
				spotifyRateLimit.recordSuccess(url);
			}

			return response;
		} catch (e) {
			const msg =
				e instanceof Error && e.name === "AbortError"
					? `timeout after ${REQUEST_TIMEOUT_MS}ms`
					: e instanceof Error
						? e.message
						: String(e);
			this.setLastError(msg);
			streamDeck.logger.error(`[Spotify] request failed: ${url} ${msg}`);
			return null;
		}
	}
}

export const spotifyApiGateway = new SpotifyApiGateway();
