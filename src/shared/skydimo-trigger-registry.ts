import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SkydimoLightingTriggers = {
	screenSyncExeFileName: string;
	screenSyncRelativeDir: string;
	screenStaticExeFileName: string;
	screenStaticRelativeDir: string;
	lightingOffExeFileName: string;
	lightingOffRelativeDir: string;
	/** Window title set on the Screen Sync trigger form (for Skydimo "title contains" rules) */
	screenSyncWindowTitle: string;
	/** Window title set on the Static trigger form */
	staticWindowTitle: string;
	/** Window title set on the Lighting Off trigger form */
	lightingOffWindowTitle: string;
};

export const SKYDIMO_LIGHTING_TRIGGERS: SkydimoLightingTriggers = {
	screenSyncExeFileName: "SkydimoTrigger.ScreenSync.exe",
	screenSyncRelativeDir: "triggers/skydimo-screen-sync",
	screenSyncWindowTitle: "QuickBits Skydimo ScreenSync",

	screenStaticExeFileName: "SkydimoTrigger.ScreenStatic.exe",
	screenStaticRelativeDir: "triggers/skydimo-screen-static",
	staticWindowTitle: "QuickBits Skydimo Static",

	lightingOffExeFileName: "SkydimoTrigger.LightingOff.exe",
	lightingOffRelativeDir: "triggers/skydimo-lighting-off",
	lightingOffWindowTitle: "QuickBits Skydimo LightingOff"
};

export function getSkydimoScreenSyncTriggerPath(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	return join(currentDir, "..", SKYDIMO_LIGHTING_TRIGGERS.screenSyncRelativeDir, SKYDIMO_LIGHTING_TRIGGERS.screenSyncExeFileName);
}

export function getSkydimoScreenStaticTriggerPath(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	return join(
		currentDir,
		"..",
		SKYDIMO_LIGHTING_TRIGGERS.screenStaticRelativeDir,
		SKYDIMO_LIGHTING_TRIGGERS.screenStaticExeFileName
	);
}

export function getSkydimoLightingOffTriggerPath(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	return join(
		currentDir,
		"..",
		SKYDIMO_LIGHTING_TRIGGERS.lightingOffRelativeDir,
		SKYDIMO_LIGHTING_TRIGGERS.lightingOffExeFileName
	);
}
