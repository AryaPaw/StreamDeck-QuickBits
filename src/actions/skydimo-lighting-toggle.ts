import { existsSync } from "node:fs";
import streamDeck, {
	action,
	KeyDownEvent,
	KeyUpEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";
import { normalizeSkydimoLightingMode, SkydimoLightingToggleSettings } from "../shared/settings";
import {
	getSkydimoLightingOffTriggerPath,
	getSkydimoScreenStaticTriggerPath,
	getSkydimoScreenSyncTriggerPath
} from "../shared/skydimo-trigger-registry";
import { processManager } from "../shared/process-manager";

const SKYDIMO_KEY_IMAGE_SYNC = "imgs/actions/marker-skydimo-screen-sync/sync";
const SKYDIMO_KEY_IMAGE_STATIC = "imgs/actions/marker-skydimo-screen-sync/static";
const SKYDIMO_KEY_IMAGE_OFF = "imgs/actions/marker-skydimo-screen-sync/off";

/**
 * Toggles Skydimo lighting mode via short-lived foreground GUI trigger apps.
 * UUID kept for compatibility with existing Stream Deck profiles (was marker action).
 *
 * UI uses a single manifest state + setImage(): multi-state setState(0|1) was unreliable
 * on some Stream Deck builds, and setTitle() without { state } applies to both states.
 *
 * - Short tap (release before hold threshold): toggle Sync / Static on key up; from Off, next tap goes to Static.
 * - Long hold: separate LightingOff trigger exe (Skydimo third profile) and persist `lightingMode: "off"`.
 */
@action({ UUID: "dev.aryapaw.quickbits.marker-skydimo-screen-sync" })
export class SkydimoLightingToggleAction extends SingletonAction<SkydimoLightingToggleSettings> {
	private readonly inFlightContextIds = new Set<string>();
	private readonly lastToggleByContext = new Map<string, number>();
	private readonly minToggleIntervalMs = 250;
	/** Hold at least this long to fire the Lighting Off trigger exe. */
	private readonly longPressMs = 650;
	private readonly keySessions = new Map<
		string,
		{
			timer: ReturnType<typeof setTimeout> | null;
			longPressHandled: boolean;
			action: KeyDownEvent<SkydimoLightingToggleSettings>["action"];
		}
	>();

	override async onWillAppear(ev: WillAppearEvent<SkydimoLightingToggleSettings>): Promise<void> {
		await this.applyUi(ev.action, ev.payload.settings);
	}

	override async onWillDisappear(ev: WillDisappearEvent<SkydimoLightingToggleSettings>): Promise<void> {
		this.clearKeySession(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<SkydimoLightingToggleSettings>): Promise<void> {
		const contextId = ev.action.id;
		if (this.inFlightContextIds.has(contextId)) {
			return;
		}

		this.clearKeySession(contextId);

		const session = {
			timer: null as ReturnType<typeof setTimeout> | null,
			longPressHandled: false,
			action: ev.action
		};
		session.timer = setTimeout(() => {
			void this.onLongPress(contextId);
		}, this.longPressMs);
		this.keySessions.set(contextId, session);
	}

	override async onKeyUp(ev: KeyUpEvent<SkydimoLightingToggleSettings>): Promise<void> {
		const contextId = ev.action.id;
		const session = this.keySessions.get(contextId);
		this.keySessions.delete(contextId);
		if (!session) {
			return;
		}
		if (session.timer) {
			clearTimeout(session.timer);
			session.timer = null;
		}
		if (session.longPressHandled) {
			return;
		}

		await this.runToggleSyncStatic(session.action, contextId);
	}

	private clearKeySession(contextId: string): void {
		const session = this.keySessions.get(contextId);
		if (session?.timer) {
			clearTimeout(session.timer);
		}
		this.keySessions.delete(contextId);
	}

	private canTrigger(contextId: string): boolean {
		const now = Date.now();
		const lastToggleAt = this.lastToggleByContext.get(contextId) ?? 0;
		return !this.inFlightContextIds.has(contextId) && now - lastToggleAt >= this.minToggleIntervalMs;
	}

	private async onLongPress(contextId: string): Promise<void> {
		const session = this.keySessions.get(contextId);
		if (!session) {
			return;
		}
		if (session.timer) {
			clearTimeout(session.timer);
			session.timer = null;
		}

		if (!this.canTrigger(contextId)) {
			return;
		}
		session.longPressHandled = true;

		await this.runLightingOff(session.action, contextId);
	}

	private async runLightingOff(
		action: KeyDownEvent<SkydimoLightingToggleSettings>["action"],
		contextId: string
	): Promise<void> {
		if (!this.canTrigger(contextId)) {
			return;
		}

		const now = Date.now();
		this.inFlightContextIds.add(contextId);
		this.lastToggleByContext.set(contextId, now);

		try {
			const exePath = getSkydimoLightingOffTriggerPath();
			if (!existsSync(exePath)) {
				streamDeck.logger.error(`[SkydimoLightingToggle] Missing trigger exe: ${exePath}`);
				await action.showAlert();
				return;
			}

			const ok = await processManager.startGuiTriggerProcess(exePath);
			if (!ok) {
				await action.showAlert();
				return;
			}

			const newSettings: SkydimoLightingToggleSettings = { lightingMode: "off", screenSyncActive: false };
			await action.setSettings(newSettings);
			await this.applyUi(action, newSettings);
		} finally {
			this.inFlightContextIds.delete(contextId);
			this.lastToggleByContext.set(contextId, Date.now());
		}
	}

	private async runToggleSyncStatic(
		action: KeyDownEvent<SkydimoLightingToggleSettings>["action"],
		contextId: string
	): Promise<void> {
		if (!this.canTrigger(contextId)) {
			return;
		}

		const now = Date.now();
		this.inFlightContextIds.add(contextId);
		this.lastToggleByContext.set(contextId, now);

		try {
			const currentSettings = await action.getSettings();
			const mode = normalizeSkydimoLightingMode(currentSettings);
			const nextMode = mode === "off" ? "static" : mode === "sync" ? "static" : "sync";

			const exePath =
				nextMode === "sync" ? getSkydimoScreenSyncTriggerPath() : getSkydimoScreenStaticTriggerPath();

			if (!existsSync(exePath)) {
				streamDeck.logger.error(`[SkydimoLightingToggle] Missing trigger exe: ${exePath}`);
				await action.showAlert();
				return;
			}

			const ok = await processManager.startGuiTriggerProcess(exePath);
			if (!ok) {
				await action.showAlert();
				return;
			}

			const newSettings: SkydimoLightingToggleSettings = {
				lightingMode: nextMode,
				screenSyncActive: nextMode === "sync"
			};
			await action.setSettings(newSettings);
			await this.applyUi(action, newSettings);
		} finally {
			this.inFlightContextIds.delete(contextId);
			this.lastToggleByContext.set(contextId, Date.now());
		}
	}

	private async applyUi(
		action: WillAppearEvent<SkydimoLightingToggleSettings>["action"],
		settings: SkydimoLightingToggleSettings
	): Promise<void> {
		const mode = normalizeSkydimoLightingMode(settings);
		const imagePath =
			mode === "sync" ? SKYDIMO_KEY_IMAGE_SYNC : mode === "static" ? SKYDIMO_KEY_IMAGE_STATIC : SKYDIMO_KEY_IMAGE_OFF;
		if (action.isKey()) {
			await action.setImage(imagePath);
		}
		await action.setTitle(mode === "sync" ? "Sync" : mode === "static" ? "Static" : "Light Off");
	}

	/**
	 * Persist Static on every visible instance (startup bootstrap after Skydimo is running).
	 */
	async pushStaticToAllVisibleInstances(): Promise<void> {
		const settings: SkydimoLightingToggleSettings = { lightingMode: "static", screenSyncActive: false };
		for (const a of this.actions) {
			await a.setSettings(settings);
			await this.applyUi(a, settings);
		}
	}
}
