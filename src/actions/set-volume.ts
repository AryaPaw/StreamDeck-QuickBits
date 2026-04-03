import { action, DidReceiveSettingsEvent, KeyDownEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import { setVolume } from "../shared/helper";
import { normalizePercent, SetVolumeSettings } from "../shared/settings";

@action({ UUID: "dev.aryapaw.quickbits.set-volume" })
export class SetVolumeAction extends SingletonAction<SetVolumeSettings> {
	override async onWillAppear(ev: WillAppearEvent<SetVolumeSettings>): Promise<void> {
		const percent = normalizePercent(ev.payload.settings.percent);

		if (ev.payload.settings.percent === undefined) {
			await ev.action.setSettings({ percent });
		}

		await ev.action.setTitle(`${percent}%`);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetVolumeSettings>): Promise<void> {
		const percent = normalizePercent(ev.payload.settings.percent);
		await ev.action.setTitle(`${percent}%`);
	}

	override async onKeyDown(ev: KeyDownEvent<SetVolumeSettings>): Promise<void> {
		const percent = normalizePercent(ev.payload.settings.percent);
		const success = await setVolume(percent);

		if (success) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}
