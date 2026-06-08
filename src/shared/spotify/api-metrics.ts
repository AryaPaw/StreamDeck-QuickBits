import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPluginRoot } from "./plugin-paths";
import { spotifyRateLimit } from "./rate-limit";

export type ApiEventKind = "request" | "skipped" | "cache_hit" | "429" | "blocked";

export type ApiTrackContext = {
	title?: string;
	artist?: string;
};

export type ApiEvent = {
	ts: number;
	kind: ApiEventKind;
	bucket: "search" | "library";
	method: string;
	endpoint: string;
	reason?: string;
	trackTitle?: string;
	trackArtist?: string;
	status?: number;
};

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RING_SIZE = 500;
const PERSIST_DEBOUNCE_MS = 2_000;

function metricsPath(): string {
	return join(getPluginRoot(), "cache", "api-metrics.jsonl");
}

function trackFields(track?: ApiTrackContext): Pick<ApiEvent, "trackTitle" | "trackArtist"> {
	if (!track) {
		return {};
	}
	return {
		...(track.title ? { trackTitle: track.title } : {}),
		...(track.artist ? { trackArtist: track.artist } : {})
	};
}

class SpotifyApiMetrics {
	private ring: ApiEvent[] = [];
	private pendingPersist: ApiEvent[] = [];
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private hydrated = false;

	async hydrate(): Promise<void> {
		if (this.hydrated) {
			return;
		}
		this.hydrated = true;

		const path = metricsPath();
		if (!existsSync(path)) {
			return;
		}

		try {
			const text = await readFile(path, "utf-8");
			const cutoff = Date.now() - RETENTION_MS;
			const lines = text.split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const event = JSON.parse(line) as ApiEvent;
					if (event.ts >= cutoff) {
						this.ring.push(event);
					}
				} catch {
					// skip corrupt line
				}
			}
			if (this.ring.length > RING_SIZE) {
				this.ring = this.ring.slice(-RING_SIZE);
			}
		} catch {
			// ignore read errors
		}
	}

	record(input: {
		kind: ApiEventKind;
		bucket: "search" | "library";
		method: string;
		endpoint: string;
		reason?: string;
		status?: number;
		track?: ApiTrackContext;
	}): void {
		const event: ApiEvent = {
			ts: Date.now(),
			kind: input.kind,
			bucket: input.bucket,
			method: input.method,
			endpoint: input.endpoint,
			...(input.reason ? { reason: input.reason } : {}),
			...(input.status !== undefined ? { status: input.status } : {}),
			...trackFields(input.track)
		};

		this.ring.push(event);
		if (this.ring.length > RING_SIZE) {
			this.ring.shift();
		}

		this.pendingPersist.push(event);
		this.schedulePersist();
	}

	recordPolicySkip(
		reason: string,
		endpoint: string,
		bucket: "search" | "library",
		track?: ApiTrackContext
	): void {
		this.record({
			kind: "skipped",
			bucket,
			method: "GET",
			endpoint,
			reason,
			track
		});
	}

	getEvents(limit = 200): ApiEvent[] {
		return this.ring.slice(-limit).reverse();
	}

	getMetricsSnapshot(rolling30s: { total: number; limit: number }) {
		const now = Date.now();
		const minuteMs = 60_000;
		const buckets: Record<string, { request: number; skipped: number; cache_hit: number; blocked: number; r429: number }> =
			{};

		for (const event of this.ring) {
			if (event.ts < now - 60 * minuteMs) {
				continue;
			}
			const minuteKey = String(Math.floor(event.ts / minuteMs) * minuteMs);
			if (!buckets[minuteKey]) {
				buckets[minuteKey] = { request: 0, skipped: 0, cache_hit: 0, blocked: 0, r429: 0 };
			}
			const row = buckets[minuteKey];
			if (event.kind === "request") row.request += 1;
			else if (event.kind === "skipped") row.skipped += 1;
			else if (event.kind === "cache_hit") row.cache_hit += 1;
			else if (event.kind === "blocked") row.blocked += 1;
			else if (event.kind === "429") row.r429 += 1;
		}

		const perMinute = Object.entries(buckets)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([minute, counts]) => ({ minute: Number(minute), ...counts }));

		return {
			rolling30s,
			backoff: {
				blockedMs: spotifyRateLimit.shouldThrottle() ? spotifyRateLimit.msUntilReady() : 0,
				requestLimit: spotifyRateLimit.getRequestLimit()
			},
			perMinute,
			eventCount: this.ring.length
		};
	}

	exportJson(): string {
		return JSON.stringify(this.ring, null, 2);
	}

	private schedulePersist(): void {
		if (this.persistTimer) {
			return;
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.flushPersist();
		}, PERSIST_DEBOUNCE_MS);
	}

	private async flushPersist(): Promise<void> {
		if (this.pendingPersist.length === 0) {
			return;
		}
		const batch = this.pendingPersist.splice(0);
		const path = metricsPath();
		const dir = join(getPluginRoot(), "cache");

		try {
			if (!existsSync(dir)) {
				await mkdir(dir, { recursive: true });
			}
			const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
			await appendFile(path, lines, "utf-8");
			await this.rotateOldLines(path);
		} catch {
			this.pendingPersist.unshift(...batch);
		}
	}

	private async rotateOldLines(path: string): Promise<void> {
		if (!existsSync(path)) {
			return;
		}
		try {
			const text = await readFile(path, "utf-8");
			const cutoff = Date.now() - RETENTION_MS;
			const kept = text
				.split("\n")
				.filter(Boolean)
				.filter((line) => {
					try {
						return (JSON.parse(line) as ApiEvent).ts >= cutoff;
					} catch {
						return false;
					}
				});
			if (kept.length === 0) {
				return;
			}
			const trimmed = kept.slice(-5000);
			if (trimmed.length < text.split("\n").filter(Boolean).length) {
				const { writeFile } = await import("node:fs/promises");
				await writeFile(path, trimmed.map((l) => l + "\n").join(""), "utf-8");
			}
		} catch {
			// ignore rotation errors
		}
	}
}

export const spotifyApiMetrics = new SpotifyApiMetrics();
