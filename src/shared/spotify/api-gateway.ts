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

class SpotifyApiGateway {
	private requestTimestamps: number[] = [];
	private inflight = new Map<string, Promise<Response | null>>();
	private dailyRequestCount = 0;
	private dailyRequestDayKey = "";

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
			limit: SPOTIFY_WEB_API_LIMITS.dailyRequestLimit
		};
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
		}
	}

	private recordDailyRequest(): void {
		this.trimDailyCounter();
		this.dailyRequestCount += 1;
		if (this.dailyRequestCount === SPOTIFY_WEB_API_LIMITS.dailyRequestWarnAt) {
			streamDeck.logger.warn(
				`[Spotify] Daily Web API usage at ${this.dailyRequestCount}/${SPOTIFY_WEB_API_LIMITS.dailyRequestLimit}`
			);
		}
	}

	private isDailyCapExceeded(): boolean {
		this.trimDailyCounter();
		return this.dailyRequestCount >= SPOTIFY_WEB_API_LIMITS.dailyRequestLimit;
	}

	private shouldBypassQuota(options: ApiGatewayOptions): boolean {
		return (
			options.bypassQuota === true ||
			options.bypassLibraryThrottle === true ||
			options.priority === "manual"
		);
	}

	private shouldBlockProactive(options: ApiGatewayOptions): "blocked" | "quota" | "daily" | null {
		if (spotifyRateLimit.shouldThrottle()) {
			return "blocked";
		}

		if (this.shouldBypassQuota(options)) {
			return null;
		}

		if (this.isDailyCapExceeded()) {
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
			return existing;
		}

		const blockReason = this.shouldBlockProactive(options);
		if (blockReason) {
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

		const promise = this.executeRequest(settings, url, {
			...options,
			method,
			reason,
			bucket,
			endpoint
		});
		this.inflight.set(dedupeKey, promise);
		try {
			return await promise;
		} finally {
			if (this.inflight.get(dedupeKey) === promise) {
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
		this.recordDailyRequest();

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
			return null;
		}

		const doFetch = (authToken: string) => {
			const headers = { ...(ctx.headers ?? {}), Authorization: `Bearer ${authToken}` };
			return fetch(url, { method: ctx.method, headers });
		};

		try {
			let response = await doFetch(token);
			if (response.status === 401) {
				token = await spotifyAuth.ensureAccessToken(settings, true);
				if (!token) {
					return null;
				}
				response = await doFetch(token);
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
			streamDeck.logger.error(`[Spotify] request failed: ${url} ${e}`);
			return null;
		}
	}
}

export const spotifyApiGateway = new SpotifyApiGateway();
