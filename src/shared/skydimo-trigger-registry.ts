import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SkydimoTriggerPair = {
	screenSyncExeFileName: string;
	screenSyncRelativeDir: string;
	screenStaticExeFileName: string;
	screenStaticRelativeDir: string;
	/** Window title set on the Screen Sync trigger form (for Skydimo "title contains" rules) */
	screenSyncWindowTitle: string;
	/** Window title set on the Static trigger form */
	staticWindowTitle: string;
};

export const SKYDIMO_LIGHTING_TRIGGERS: SkydimoTriggerPair = {
	// Screen Sync trigger
	screenSyncExeFileName: "SkydimoTrigger.ScreenSync.exe",
	screenSyncRelativeDir: "triggers/skydimo-screen-sync",
	screenSyncWindowTitle: "QuickBits Skydimo ScreenSync",

	// Screen Static trigger
	screenStaticExeFileName: "SkydimoTrigger.ScreenStatic.exe",
	screenStaticRelativeDir: "triggers/skydimo-screen-static",
	staticWindowTitle: "QuickBits Skydimo Static"
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
