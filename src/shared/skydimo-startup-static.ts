import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import streamDeck from "@elgato/streamdeck";
import type { SkydimoLightingToggleAction } from "../actions/skydimo-lighting-toggle";
import { processManager } from "./process-manager";
import { getSkydimoScreenStaticTriggerPath } from "./skydimo-trigger-registry";

const execFileAsync = promisify(execFile);

/** Default install path used to decide whether startup bootstrap runs (Skydimo not installed → no 3‑minute wait). */
const SKYDIMO_DEFAULT_EXE = "C:\\Program Files\\Skydimo\\Skydimo.exe";
const STARTUP_POLL_MS = 2000;
const STARTUP_TIMEOUT_MS = 180_000;
const KEYS_RETRY_DELAY_MS = 1000;
const KEYS_MAX_ATTEMPTS = 30;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isSkydimoProcessRunning(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq Skydimo.exe", "/NH"], {
			windowsHide: true
		});
		return /\bSkydimo\.exe\b/i.test(stdout);
	} catch {
		return false;
	}
}

function visibleSkydimoKeyCount(singleton: SkydimoLightingToggleAction): number {
	let n = 0;
	for (const _ of singleton.actions) {
		n++;
	}
	return n;
}

/**
 * After plugin connect: if default Skydimo is installed, wait until Skydimo.exe is running (up to 3 min),
 * run the Static foreground trigger once, then persist Static on all visible lighting keys.
 */
export async function runSkydimoStartupStaticBootstrap(singleton: SkydimoLightingToggleAction): Promise<void> {
	if (process.platform !== "win32") {
		return;
	}

	if (!existsSync(SKYDIMO_DEFAULT_EXE)) {
		streamDeck.logger.info(
			`[SkydimoStartup] ${SKYDIMO_DEFAULT_EXE} not found; skipping startup static bootstrap.`
		);
		return;
	}

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await isSkydimoProcessRunning()) {
			break;
		}
		await sleep(STARTUP_POLL_MS);
	}

	if (!(await isSkydimoProcessRunning())) {
		streamDeck.logger.warn("[SkydimoStartup] Skydimo.exe did not start within 3 minutes; skipping static trigger.");
		return;
	}

	const exePath = getSkydimoScreenStaticTriggerPath();
	if (!existsSync(exePath)) {
		streamDeck.logger.error(`[SkydimoStartup] Missing static trigger: ${exePath}`);
		return;
	}

	const ok = await processManager.startGuiTriggerProcess(exePath);
	if (!ok) {
		streamDeck.logger.error("[SkydimoStartup] Failed to start static trigger exe.");
		return;
	}

	for (let attempt = 0; attempt < KEYS_MAX_ATTEMPTS; attempt++) {
		if (visibleSkydimoKeyCount(singleton) > 0) {
			await singleton.pushStaticToAllVisibleInstances();
			streamDeck.logger.info("[SkydimoStartup] Applied Static to visible Skydimo lighting keys.");
			return;
		}
		await sleep(KEYS_RETRY_DELAY_MS);
	}

	streamDeck.logger.warn("[SkydimoStartup] Static trigger ran but no visible lighting keys to sync yet.");
}
