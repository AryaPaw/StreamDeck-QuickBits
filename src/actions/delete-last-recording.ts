import {
	action,
	DidReceiveSettingsEvent,
	KeyDownEvent,
	KeyUpEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";
import { KeyPressGuard } from "../shared/key-press-guard";
import { recycleFileToBin, restoreFileFromBin } from "../shared/helper";
import {
	type DeleteLastRecordingSettings,
	normalizeMaxAgeSeconds,
	resolveRecordingFolder,
	selectLastRecording,
	statusTitleForFailure,
	statusTitleForRestoreFailure,
	validateRestoreTarget
} from "../shared/delete-last-recording";

const IDLE_IMAGE = "imgs/actions/delete-last-recording/key";
const OK_IMAGE = "imgs/actions/delete-last-recording/ok";
const FAIL_IMAGE = "imgs/actions/delete-last-recording/fail";
const IDLE_TITLE = "Last clip";
const STATUS_RESET_MS = 2800;
const LONG_PRESS_MS = 350;

@action({ UUID: "dev.aryapaw.quickbits.delete-last-recording" })
export class DeleteLastRecordingAction extends SingletonAction<DeleteLastRecordingSettings> {
	private readonly keyPressGuard = new KeyPressGuard(800);
	private readonly resetTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly keySessions = new Map<
		string,
		{
			timer: ReturnType<typeof setTimeout> | null;
			longPressHandled: boolean;
			action: KeyDownEvent<DeleteLastRecordingSettings>["action"];
		}
	>();

	override async onWillAppear(ev: WillAppearEvent<DeleteLastRecordingSettings>): Promise<void> {
		const folderPath = resolveRecordingFolder(ev.payload.settings.folderPath);
		const rawAge = ev.payload.settings.maxAgeSeconds;
		const maxAgeSeconds =
			rawAge === undefined || Number(rawAge) === 10
				? 5
				: normalizeMaxAgeSeconds(rawAge);
		if (
			ev.payload.settings.folderPath?.trim() !== folderPath ||
			ev.payload.settings.maxAgeSeconds !== maxAgeSeconds
		) {
			await ev.action.setSettings({
				folderPath,
				maxAgeSeconds,
				lastRecycledPath: ev.payload.settings.lastRecycledPath
			});
		}
		this.clearReset(ev.action.id);
		await this.renderIdle(ev.action);
	}

	override async onWillDisappear(ev: WillDisappearEvent<DeleteLastRecordingSettings>): Promise<void> {
		this.clearKeySession(ev.action.id);
		this.clearReset(ev.action.id);
	}

	override async onDidReceiveSettings(
		ev: DidReceiveSettingsEvent<DeleteLastRecordingSettings>
	): Promise<void> {
		const folderPath = resolveRecordingFolder(ev.payload.settings.folderPath);
		const maxAgeSeconds = normalizeMaxAgeSeconds(ev.payload.settings.maxAgeSeconds);
		await ev.action.setSettings({
			folderPath,
			maxAgeSeconds,
			lastRecycledPath: ev.payload.settings.lastRecycledPath
		});
		await this.renderIdle(ev.action);
	}

	override async onKeyDown(ev: KeyDownEvent<DeleteLastRecordingSettings>): Promise<void> {
		const contextId = ev.action.id;
		if (this.keyPressGuard.isInFlight(contextId)) {
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
		}, LONG_PRESS_MS);
		this.keySessions.set(contextId, session);
	}

	override async onKeyUp(ev: KeyUpEvent<DeleteLastRecordingSettings>): Promise<void> {
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

		await this.keyPressGuard.run(contextId, async () => {
			await this.deleteLastClip(session.action);
		});
	}

	private clearKeySession(contextId: string): void {
		const session = this.keySessions.get(contextId);
		if (session?.timer) {
			clearTimeout(session.timer);
		}
		this.keySessions.delete(contextId);
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
		session.longPressHandled = true;
		await this.keyPressGuard.run(contextId, async () => {
			await this.restoreLastClip(session.action);
		});
	}

	private async deleteLastClip(
		action: KeyDownEvent<DeleteLastRecordingSettings>["action"]
	): Promise<void> {
		const settings = await action.getSettings();
		const folderPath = resolveRecordingFolder(settings.folderPath);
		const maxAgeSeconds = normalizeMaxAgeSeconds(settings.maxAgeSeconds);
		const selected = selectLastRecording(folderPath, Date.now(), maxAgeSeconds * 1000);

		if (!selected.ok) {
			await this.renderStatus(action, FAIL_IMAGE, statusTitleForFailure(selected.reason));
			await action.showAlert();
			return;
		}

		const recycled = await recycleFileToBin(selected.filePath, folderPath, maxAgeSeconds);
		if (!recycled.success) {
			await this.renderStatus(action, FAIL_IMAGE, "Failed");
			await action.showAlert();
			return;
		}

		await action.setSettings({
			folderPath,
			maxAgeSeconds,
			lastRecycledPath: selected.filePath
		});
		await this.renderStatus(action, OK_IMAGE, "Deleted");
		await action.showOk();
	}

	private async restoreLastClip(
		action: KeyDownEvent<DeleteLastRecordingSettings>["action"]
	): Promise<void> {
		const settings = await action.getSettings();
		const folderPath = resolveRecordingFolder(settings.folderPath);
		const maxAgeSeconds = normalizeMaxAgeSeconds(settings.maxAgeSeconds);
		const target = validateRestoreTarget(settings.lastRecycledPath, folderPath);

		if (!target.ok) {
			await this.renderStatus(action, FAIL_IMAGE, statusTitleForRestoreFailure(target.reason));
			await action.showAlert();
			return;
		}

		const restored = await restoreFileFromBin(target.filePath, folderPath);
		if (!restored.success) {
			await this.renderStatus(action, FAIL_IMAGE, "Failed");
			await action.showAlert();
			return;
		}

		await action.setSettings({
			folderPath,
			maxAgeSeconds,
			lastRecycledPath: undefined
		});
		await this.renderStatus(action, OK_IMAGE, "Restored");
		await action.showOk();
	}

	private async renderIdle(
		action: WillAppearEvent<DeleteLastRecordingSettings>["action"]
	): Promise<void> {
		await action.setImage(IDLE_IMAGE);
		await action.setTitle(IDLE_TITLE);
	}

	private async renderStatus(
		action: KeyDownEvent<DeleteLastRecordingSettings>["action"],
		image: string,
		title: string
	): Promise<void> {
		await action.setImage(image);
		await action.setTitle(title);
		this.queueIdle(action);
	}

	private queueIdle(action: KeyDownEvent<DeleteLastRecordingSettings>["action"]): void {
		this.clearReset(action.id);
		this.resetTimers.set(
			action.id,
			setTimeout(() => {
				this.resetTimers.delete(action.id);
				void this.renderIdle(action);
			}, STATUS_RESET_MS)
		);
	}

	private clearReset(contextId: string): void {
		const timer = this.resetTimers.get(contextId);
		if (timer) {
			clearTimeout(timer);
			this.resetTimers.delete(contextId);
		}
	}
}
