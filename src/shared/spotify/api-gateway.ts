import streamDeck from "@elgato/streamdeck";
import { spotifyAuth } from "./auth";
import { spotifyApiMetrics, type ApiTrackContext } from "./api-metrics";
import { spotifyRateLimit } from "./rate-limit";
import type { SpotifySettings } from "./types";

const QUOTA_WINDOW_MS = 30_000;
const SEARCH_QUOTA = 8;
const LIBRARY_QUOTA = 12;

export type ApiRequestPriority = "manual" | "normal" | "background";

export type ApiGatewayOptions = {
	method?: "GET" | "PUT" | "DELETE" | "POST";
	headers?: Record<string, string>;
	priority?: ApiRequestPriority;
	reason?: string;
	bypassLibraryThrottle?: boolean;
	track?: ApiTrackContext;
};

function bucketForUrl(url: string): "search" | "library" {
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
	private searchWindow: number[] = [];
	private libraryWindow: number[] = [];
	private inflight = new Map<string, Promise<Response | null>>();

	private trimWindow(window: number[]): void {
		const cutoff = Date.now() - QUOTA_WINDOW_MS;
		while (window.length > 0 && window[0]! < cutoff) {
			window.shift();
		}
	}

	private countInWindow(window: number[]): number {
		this.trimWindow(window);
		return window.length;
	}

	private recordQuotaUse(bucket: "search" | "library"): void {
		const window = bucket === "search" ? this.searchWindow : this.libraryWindow;
		window.push(Date.now());
	}

	private isQuotaExceeded(bucket: "search" | "library"): boolean {
		const limit = bucket === "search" ? SEARCH_QUOTA : LIBRARY_QUOTA;
		const window = bucket === "search" ? this.searchWindow : this.libraryWindow;
		return this.countInWindow(window) >= limit;
	}

	getRollingCounts(): { search: number; library: number } {
		return {
			search: this.countInWindow(this.searchWindow),
			library: this.countInWindow(this.libraryWindow)
		};
	}

	getQuotas(): { search: number; library: number } {
		return { search: SEARCH_QUOTA, library: LIBRARY_QUOTA };
	}

	private shouldBlockProactive(url: string, options: ApiGatewayOptions): "blocked" | "quota" | null {
		const bucket = bucketForUrl(url);
		const bypass = options.bypassLibraryThrottle === true || options.priority === "manual";

		if (bucket === "search" && spotifyRateLimit.shouldThrottleSearch()) {
			return "blocked";
		}
		if (bucket === "library" && !bypass && spotifyRateLimit.shouldThrottleLibrary()) {
			return "blocked";
		}

		if (bypass) {
			return null;
		}

		if (this.isQuotaExceeded(bucket)) {
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
		const bucket = bucketForUrl(url);
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

		const blockReason = this.shouldBlockProactive(url, options);
		if (blockReason) {
			spotifyApiMetrics.record({
				kind: blockReason === "quota" ? "skipped" : "blocked",
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

		const promise = this.executeRequest(settings, url, { ...options, method, reason, bucket, endpoint });
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
		this.recordQuotaUse(ctx.bucket);

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
