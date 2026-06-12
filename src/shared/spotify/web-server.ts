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

function isLocalhost(req: IncomingMessage): boolean {
	const addr = req.socket.remoteAddress;
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
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
