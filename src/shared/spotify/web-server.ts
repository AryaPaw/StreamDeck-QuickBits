import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";
import { spotifyApiGateway } from "./api-gateway";
import { spotifyApiMetrics } from "./api-metrics";
import { spotifyAPI } from "./api";
import { spotifyAuth, REDIRECT_URI, SCOPES } from "./auth";
import { loadSpotifySettings, saveSpotifySettings } from "./settings";
import { spotifyRateLimit } from "./rate-limit";
import { spotifyState } from "./state";

type ApiTestStep = {
	name: string;
	ok: boolean;
	status?: number;
	detail: string;
	ms: number;
};

function isLocalhost(req: IncomingMessage): boolean {
	const addr = req.socket.remoteAddress;
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function timedStep(name: string, fn: () => Promise<Omit<ApiTestStep, "name" | "ms">>): Promise<ApiTestStep> {
	const started = Date.now();
	try {
		const result = await fn();
		return { name, ms: Date.now() - started, ...result };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { name, ok: false, detail: msg, ms: Date.now() - started };
	}
}

async function runApiConnectivityTest(): Promise<{
	ok: boolean;
	at: string;
	summary: string;
	likeApiStatus: string;
	steps: ApiTestStep[];
}> {
	const settings = await loadSpotifySettings();
	const steps: ApiTestStep[] = [];
	const state = spotifyState.getState();

	steps.push(
		await timedStep("auth", async () => {
			if (!settings.refreshToken) {
				return { ok: false, detail: "no refresh token - open Setup and authorize" };
			}
			if (!settings.clientId || !settings.clientSecret) {
				return { ok: false, detail: "missing clientId/clientSecret" };
			}
			return {
				ok: true,
				detail: settings.accountDisplayName
					? `refresh token present (${settings.accountDisplayName})`
					: "refresh token present"
			};
		})
	);

	steps.push(
		await timedStep("token", async () => {
			spotifyApiGateway.resetLastError();
			const token = await spotifyAuth.ensureAccessToken(settings, true);
			if (!token) {
				return {
					ok: false,
					detail: spotifyApiGateway.getLastError() ?? "token refresh failed"
				};
			}
			const expiresIn = settings.tokenExpiry
				? Math.max(0, Math.round((settings.tokenExpiry - Date.now()) / 1000))
				: null;
			return {
				ok: true,
				detail: expiresIn != null ? `access token ok, expires in ${expiresIn}s` : "access token ok"
			};
		})
	);

	steps.push(
		await timedStep("profile", async () => {
			spotifyApiGateway.resetLastError();
			const profile = await spotifyAPI.fetchUserProfile(settings);
			if (!profile) {
				return {
					ok: false,
					detail: spotifyApiGateway.getLastError() ?? "GET /me failed"
				};
			}
			return { ok: true, detail: `${profile.display_name} (${profile.id})`, status: 200 };
		})
	);

	steps.push(
		await timedStep("player", async () => {
			spotifyApiGateway.resetLastError();
			const response = await spotifyApiGateway.request(
				settings,
				"https://api.spotify.com/v1/me/player",
				{ reason: "debug-probe-player", bypassQuota: true, priority: "manual" }
			);
			if (!response) {
				return {
					ok: false,
					detail: spotifyApiGateway.getLastError() ?? "GET /me/player failed"
				};
			}
			if (response.status === 204) {
				return { ok: true, status: 204, detail: "no active player session" };
			}
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				return {
					ok: false,
					status: response.status,
					detail: body.slice(0, 180) || `HTTP ${response.status}`
				};
			}
			try {
				const data = (await response.json()) as {
					item?: { name?: string; uri?: string; type?: string } | null;
					is_playing?: boolean;
				};
				const item = data.item;
				if (!item?.name) {
					return { ok: true, status: 200, detail: "player ok, no item" };
				}
				return {
					ok: true,
					status: 200,
					detail: `${data.is_playing ? "playing" : "paused"}: ${item.name} (${item.uri ?? item.type ?? "?"})`
				};
			} catch {
				return { ok: true, status: 200, detail: "player ok (unparsed body)" };
			}
		})
	);

	steps.push(
		await timedStep("library_contains", async () => {
			spotifyApiGateway.resetLastError();
			const track = state.track;
			let uri =
				(track ? spotifyAPI.getCachedUri(track.id) : undefined) ??
				(track?.uri?.startsWith("spotify:") ? track.uri : undefined);

			if (!uri) {
				// Fall back to player item from previous step is awkward - probe a noop-safe path
				const playerRes = await spotifyApiGateway.request(
					settings,
					"https://api.spotify.com/v1/me/player",
					{ reason: "debug-probe-player-uri", bypassQuota: true, priority: "manual" }
				);
				if (playerRes?.ok) {
					try {
						const data = (await playerRes.json()) as { item?: { uri?: string } | null };
						uri = data.item?.uri;
					} catch {
						/* ignore */
					}
				}
			}

			if (!uri) {
				return {
					ok: false,
					detail: "no track URI available (play something in Spotify, then retry)"
				};
			}

			const response = await spotifyApiGateway.request(
				settings,
				`https://api.spotify.com/v1/me/library/contains?uris=${encodeURIComponent(uri)}`,
				{ reason: "debug-probe-contains", bypassQuota: true, priority: "manual" }
			);
			if (!response) {
				const err = spotifyApiGateway.getLastError() ?? "request failed";
				return {
					ok: false,
					detail: err === "geo_blocked" ? "GEO BLOCKED: Spotify unavailable in this country" : err
				};
			}
			if (response.status === 403) {
				const body = await response.text().catch(() => "");
				const geo = /unavailable in this country/i.test(body);
				return {
					ok: false,
					status: 403,
					detail: geo
						? "GEO BLOCKED: Spotify unavailable in this country (VPN/proxy/DNS)"
						: body.slice(0, 180) || "forbidden"
				};
			}
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				return {
					ok: false,
					status: response.status,
					detail: body.slice(0, 180) || `HTTP ${response.status}`
				};
			}
			const data = (await response.json()) as boolean[];
			const liked = data[0] === true;
			const label = track ? `"${track.name}"` : uri;
			return {
				ok: true,
				status: 200,
				detail: `${label} -> ${liked ? "liked" : "not liked"}`
			};
		})
	);

	const failed = steps.filter((s) => !s.ok);
	const geo = failed.some((s) => /geo/i.test(s.detail));
	const ok = failed.length === 0;
	let summary: string;
	if (ok) {
		summary = "All probes passed";
	} else if (geo) {
		summary = "Geo/VPN block — library API unavailable from current IP";
	} else if (spotifyRateLimit.shouldThrottle()) {
		summary = `Rate limited — blocked for ${Math.ceil(spotifyRateLimit.msUntilReady() / 1000)}s`;
	} else {
		summary = `${failed.length} probe(s) failed`;
	}

	streamDeck.logger.info(`[Spotify] API test: ${summary}`);
	return {
		ok,
		at: new Date().toISOString(),
		summary,
		likeApiStatus: state.likeApiStatus,
		steps
	};
}

class SpotifyWebServer {
	private server: ReturnType<typeof createServer> | null = null;
	private webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

	ensure(): void {
		if (this.server) {
			return;
		}

		this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			if (!isLocalhost(req)) {
				res.writeHead(403, { "Content-Type": "text/plain" });
				res.end("Forbidden");
				return;
			}

			const url = new URL(req.url || "/", "http://127.0.0.1:5789");
			await this.handleRequest(req, res, url);
		});

		this.server.listen(5789);
		streamDeck.logger.info("[Spotify] Local web server listening on http://127.0.0.1:5789");
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		if (url.pathname === "/debug" || url.pathname === "/debug/") {
			try {
				const html = await readFile(join(this.webDir, "debug.html"), "utf-8");
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(html);
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Error loading debug page");
			}
			return;
		}

		if (url.pathname === "/debug/debug.js") {
			try {
				const js = await readFile(join(this.webDir, "debug.js"), "utf-8");
				res.writeHead(200, { "Content-Type": "application/javascript" });
				res.end(js);
			} catch {
				res.writeHead(404);
				res.end("Not found");
			}
			return;
		}

		if (url.pathname === "/debug/api/metrics" && req.method === "GET") {
			const rolling30s = spotifyApiGateway.getRollingCounts();
			const hours = Math.min(
				24,
				Math.max(1, Number.parseInt(url.searchParams.get("hours") ?? "1", 10) || 1)
			);
			const daily = spotifyApiGateway.getDailyRequestCount();
			const snapshot = await spotifyApiMetrics.getMetricsSnapshot(rolling30s, hours, daily);
			jsonResponse(res, 200, snapshot);
			return;
		}

		if (url.pathname === "/debug/api/events" && req.method === "GET") {
			const limit = Math.min(
				500,
				Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200)
			);
			jsonResponse(res, 200, { events: spotifyApiMetrics.getEvents(limit) });
			return;
		}

		if (url.pathname === "/debug/api/export" && req.method === "GET") {
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Content-Disposition": 'attachment; filename="spotify-api-metrics.json"'
			});
			res.end(spotifyApiMetrics.exportJson());
			return;
		}

		if (url.pathname === "/debug/api/test" && req.method === "POST") {
			const result = await runApiConnectivityTest();
			jsonResponse(res, 200, result);
			return;
		}

		if (url.pathname === "/settings" && req.method === "GET") {
			const settings = await loadSpotifySettings();
			jsonResponse(res, 200, {
				appName: settings.appName ?? "",
				clientId: settings.clientId ?? ""
			});
			return;
		}

		if (url.pathname === "/" || url.pathname === "/setup") {
			try {
				const html = await readFile(join(this.webDir, "setup.html"), "utf-8");
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(html);
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Error loading setup page");
			}
			return;
		}

		if (url.pathname === "/submit" && req.method === "POST") {
			let body = "";
			req.on("data", (chunk: Buffer) => (body += chunk.toString()));
			req.on("end", async () => {
				try {
					const { clientId, clientSecret, appName } = JSON.parse(body);
					const trimmedAppName = typeof appName === "string" ? appName.trim() : "";

					if (!clientId || !clientSecret) {
						jsonResponse(res, 400, { success: false, error: "Missing credentials" });
						return;
					}

					spotifyAuth.setPendingOAuthSettings({
						clientId,
						clientSecret,
						...(trimmedAppName ? { appName: trimmedAppName } : {})
					});
					await spotifyAuth.runSetupSubmitCallback(clientId, clientSecret, trimmedAppName || undefined);

					const authUrl = new URL("https://accounts.spotify.com/authorize");
					authUrl.searchParams.set("client_id", clientId);
					authUrl.searchParams.set("response_type", "code");
					authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
					authUrl.searchParams.set("scope", SCOPES);
					authUrl.searchParams.set("show_dialog", "true");

					jsonResponse(res, 200, { success: true, authUrl: authUrl.toString() });
				} catch {
					jsonResponse(res, 400, { success: false, error: "Invalid request" });
				}
			});
			return;
		}

		if (url.pathname === "/callback") {
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");

			if (code) {
				streamDeck.logger.info("[Spotify] Exchanging code for token...");
				const newSettings = await spotifyAuth.finishOAuthCallback(code);
				streamDeck.logger.info(
					`[Spotify] Token exchange result: ${newSettings?.refreshToken ? "success" : "failed"}`
				);

				if (newSettings?.refreshToken) {
					const profile = await spotifyAPI.fetchUserProfile(newSettings);
					const enrichedSettings = {
						...newSettings,
						...(profile?.display_name ? { accountDisplayName: profile.display_name } : {})
					};
					if (profile?.display_name) {
						await saveSpotifySettings(enrichedSettings);
					}
					spotifyAuth.notifySettingsReceived(enrichedSettings);
					res.writeHead(302, { Location: "/?success=true" });
					res.end();
				} else {
					res.writeHead(302, { Location: "/?error=token_failed" });
					res.end();
				}
			} else {
				res.writeHead(302, {
					Location: `/?error=${encodeURIComponent(error || "auth_failed")}`
				});
				res.end();
			}
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	}

	stop(): void {
		this.server?.close();
		this.server = null;
	}
}

export const spotifyWebServer = new SpotifyWebServer();
