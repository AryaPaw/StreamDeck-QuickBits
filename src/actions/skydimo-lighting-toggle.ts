import { existsSync } from "node:fs";
import streamDeck, {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent
} from "@elgato/streamdeck";
import { SkydimoLightingToggleSettings } from "../shared/settings";
import {
	getSkydimoScreenSyncTriggerPath,
	getSkydimoScreenStaticTriggerPath
} from "../shared/skydimo-trigger-registry";
import { processManager } from "../shared/process-manager";

const SKYDIMO_KEY_IMAGE_STATIC = "imgs/actions/marker-skydimo-screen-sync/static";
const SKYDIMO_KEY_IMAGE_SYNC = "imgs/actions/marker-skydimo-screen-sync/sync";

/**
 * Toggles Skydimo lighting mode via short-lived foreground GUI trigger apps.
 * UUID kept for compatibility with existing Stream Deck profiles (was marker action).
 *
 * UI uses a single manifest state + setImage(): multi-state setState(0|1) was unreliable
 * on some Stream Deck builds, and setTitle() without { state } applies to both states.
 */
@action({ UUID: "dev.aryapaw.quickbits.marker-skydimo-screen-sync" })
export class SkydimoLightingToggleAction extends SingletonAction<SkydimoLightingToggleSettings> {
	private readonly inFlightContextIds = new Set<string>();
	private readonly lastToggleByContext = new Map<string, number>();
	private readonly minToggleIntervalMs = 250;

	override async onWillAppear(ev: WillAppearEvent<SkydimoLightingToggleSettings>): Promise<void> {
		await this.applyUi(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<SkydimoLightingToggleSettings>): Promise<void> {
		const contextId = ev.action.id;
		const now = Date.now();
		const lastToggleAt = this.lastToggleByContext.get(contextId) ?? 0;
		if (this.inFlightContextIds.has(contextId) || now - lastToggleAt < this.minToggleIntervalMs) {
			return;
		}

		this.inFlightContextIds.add(contextId);
		this.lastToggleByContext.set(contextId, now);

		try {
			const currentSettings = await ev.action.getSettings();
			const screenSyncOn = Boolean(currentSettings.screenSyncActive);
			const nextScreenSyncOn = !screenSyncOn;

			const exePath = nextScreenSyncOn
				? getSkydimoScreenSyncTriggerPath()
				: getSkydimoScreenStaticTriggerPath();

			if (!existsSync(exePath)) {
				streamDeck.logger.error(`[SkydimoLightingToggle] Missing trigger exe: ${exePath}`);
				await ev.action.showAlert();
				return;
			}

			const ok = await processManager.startGuiTriggerProcess(exePath);
			if (!ok) {
				await ev.action.showAlert();
				return;
			}

			const newSettings: SkydimoLightingToggleSettings = { screenSyncActive: nextScreenSyncOn };
			await ev.action.setSettings(newSettings);
			await this.applyUi(ev.action, newSettings);
		} finally {
			this.inFlightContextIds.delete(contextId);
			this.lastToggleByContext.set(contextId, Date.now());
		}
	}

	private async applyUi(
		action: WillAppearEvent<SkydimoLightingToggleSettings>["action"],
		settings: SkydimoLightingToggleSettings
	): Promise<void> {
		const syncOn = Boolean(settings.screenSyncActive);
		const imagePath = syncOn ? SKYDIMO_KEY_IMAGE_SYNC : SKYDIMO_KEY_IMAGE_STATIC;
		if (action.isKey()) {
			await action.setImage(imagePath);
		}
		await action.setTitle(syncOn ? "Sync" : "Static");
	}
}
