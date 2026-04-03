import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import { toggleDnd } from "../shared/helper";
import { ToggleDndSettings } from "../shared/settings";

@action({ UUID: "dev.aryapaw.quickbits.toggle-dnd" })
export class ToggleDndAction extends SingletonAction<ToggleDndSettings> {
	override async onWillAppear(ev: WillAppearEvent<ToggleDndSettings>): Promise<void> {
		await ev.action.setTitle("DND");
	}

	override async onKeyDown(ev: KeyDownEvent<ToggleDndSettings>): Promise<void> {
		const success = await toggleDnd();

		if (success) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}
