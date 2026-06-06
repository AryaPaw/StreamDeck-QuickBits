import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import streamDeck from "@elgato/streamdeck";
import type { DaemonCommandName, DaemonOutboundEvent, SpotifyLocalState, StateListener } from "./types";

const HELPER_NAME = "QuickbitsHelper.exe";
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = 2000;
const COMMAND_TIMEOUT_MS = 3000;

function getPluginRoot(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	return join(currentDir, "..");
}

function getHelperPath(): string {
	return join(getPluginRoot(), "helper", HELPER_NAME);
}

function resolveArtworkPath(relativePath: string): string {
	const absolute = join(getPluginRoot(), relativePath);
	return existsSync(absolute) ? absolute : relativePath;
}

function trackArtKey(title: string, artist: string, album: string): string {
	return `${title}\0${artist}\0${album}`;
}

export class SpotifyLocalDaemon {
	private process: ChildProcessWithoutNullStreams | null = null;
	private listeners = new Set<StateListener>();
	private commandId = 0;
	private pending = new Map<number, { resolve: (ok: boolean) => void; reject: (err: Error) => void }>();
	private restartAttempts = 0;
	private stopping = false;
	private startPromise: Promise<void> | null = null;
	private lastState: SpotifyLocalState | null = null;
	private cachedArtwork: {
		trackKey: string;
		artworkPath: string;
	} | null = null;

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		if (this.lastState) {
			listener(this.resolveStateArtwork(this.lastState));
		}
		void this.ensureStarted();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				void this.stop();
			}
		};
	}

	async sendCommand(cmd: DaemonCommandName): Promise<boolean> {
		await this.ensureStarted();
		if (!this.process?.stdin.writable) {
			return false;
		}

		const id = ++this.commandId;
		const isTransport =
			cmd === "play" ||
			cmd === "pause" ||
			cmd === "togglePlayPause" ||
			cmd === "next" ||
			cmd === "previous";

		return new Promise<boolean>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				if (isTransport) {
					resolve(true);
					return;
				}
				reject(new Error(`Daemon command timeout: ${cmd}`));
			}, COMMAND_TIMEOUT_MS);

			this.pending.set(id, {
				resolve: (ok) => {
					clearTimeout(timeout);
					resolve(ok);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				}
			});

			try {
				this.process?.stdin.write(JSON.stringify({ id, cmd }) + "\n");
			} catch (err) {
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		}).catch((err) => {
			streamDeck.logger.error(`[SpotifyLocal] ${err}`);
			return false;
		});
	}

	private async ensureStarted(): Promise<void> {
		if (this.process) return;
		if (this.startPromise) return this.startPromise;

		this.startPromise = this.start();
		try {
			await this.startPromise;
		} finally {
			this.startPromise = null;
		}
	}

	private async start(): Promise<void> {
		if (process.platform !== "win32") {
			streamDeck.logger.warn("[SpotifyLocal] GSMTC daemon is Windows-only");
			return;
		}

		const helperPath = getHelperPath();
		if (!existsSync(helperPath)) {
			streamDeck.logger.error(`[SpotifyLocal] Helper not found: ${helperPath}`);
			return;
		}

		this.stopping = false;
		const pluginRoot = getPluginRoot();
		const child = spawn(
			helperPath,
			["spotify-daemon", "--filter", "Spotify", "--plugin-dir", pluginRoot],
			{
				stdio: ["pipe", "pipe", "pipe"],
				cwd: pluginRoot,
				windowsHide: true
			}
		);

		this.process = child;
		const rl = createInterface({ input: child.stdout });

		rl.on("line", (line) => this.handleLine(line));

		const stderrRl = createInterface({ input: child.stderr });
		stderrRl.on("line", (line) => {
			if (line.includes('"event":"result"')) {
				this.handleLine(line);
				return;
			}
			streamDeck.logger.debug(`[SpotifyLocal] ${line}`);
		});

		child.on("exit", (code) => {
			this.process = null;
			this.rejectAllPending(new Error(`Daemon exited with code ${code ?? "unknown"}`));
			if (!this.stopping && this.listeners.size > 0 && this.restartAttempts < MAX_RESTART_ATTEMPTS) {
				this.restartAttempts += 1;
				const delay = RESTART_BACKOFF_MS * this.restartAttempts;
				streamDeck.logger.warn(`[SpotifyLocal] Restarting daemon in ${delay}ms`);
				setTimeout(() => void this.ensureStarted(), delay);
			}
		});
	}

	private resolveStateArtwork(state: SpotifyLocalState): SpotifyLocalState {
		const track = state.currentTrack;
		if (!track) {
			return state;
		}

		if (track.artworkPath) {
			return {
				...state,
				currentTrack: {
					...track,
					artworkPath: resolveArtworkPath(track.artworkPath)
				}
			};
		}

		return this.mergeArtwork(state);
	}

	private mergeArtwork(state: SpotifyLocalState): SpotifyLocalState {
		const track = state.currentTrack;
		if (!track || !this.cachedArtwork) {
			return state;
		}

		const key = trackArtKey(track.title, track.artist, track.album);
		if (key !== this.cachedArtwork.trackKey) {
			return state;
		}

		return {
			...state,
			currentTrack: {
				...track,
				artworkPath: this.cachedArtwork.artworkPath
			}
		};
	}

	private emitState(state: SpotifyLocalState): void {
		this.lastState = state;
		const resolved = this.resolveStateArtwork(state);
		for (const listener of this.listeners) {
			listener(resolved);
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;

		let event: DaemonOutboundEvent;
		try {
			event = JSON.parse(line) as DaemonOutboundEvent;
		} catch {
			streamDeck.logger.warn(`[SpotifyLocal] Invalid daemon JSON (${line.length} chars)`);
			return;
		}

		if (event.event === "result" && "id" in event) {
			const pending = this.pending.get(event.id);
			if (pending) {
				this.pending.delete(event.id);
				if (event.ok) {
					pending.resolve(true);
				} else {
					pending.reject(new Error(event.error || "Daemon command failed"));
				}
			}
			return;
		}

		if (event.event === "ready") {
			this.restartAttempts = 0;
			return;
		}

		if (event.event === "artwork") {
			this.cachedArtwork = {
				trackKey: trackArtKey(event.title, event.artist, event.album),
				artworkPath: resolveArtworkPath(event.artworkPath)
			};
			if (this.lastState) {
				this.emitState(this.lastState);
			}
			return;
		}

		if (event.event === "state") {
			const track = event.payload.currentTrack;
			if (track && this.cachedArtwork) {
				const key = trackArtKey(track.title, track.artist, track.album);
				if (key !== this.cachedArtwork.trackKey) {
					this.cachedArtwork = null;
				}
			} else if (!track) {
				this.cachedArtwork = null;
			}

			this.emitState(event.payload);
			return;
		}

		if (event.event === "error") {
			streamDeck.logger.warn(`[SpotifyLocal] ${event.message}`);
		}
	}

	private rejectAllPending(err: Error): void {
		for (const [, pending] of this.pending) {
			pending.reject(err);
		}
		this.pending.clear();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.process?.stdin.writable) {
			try {
				this.process.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
			} catch {
				// ignore
			}
		}
		this.process?.kill();
		this.process = null;
		this.lastState = null;
		this.cachedArtwork = null;
		this.rejectAllPending(new Error("Daemon stopped"));
	}
}

export const spotifyLocalDaemon = new SpotifyLocalDaemon();
