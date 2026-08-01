import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import { toggleDnd } from "../shared/helper";
import { DND_TOGGLE_CYCLE_MS, KeyPressGuard } from "../shared/key-press-guard";
import { ToggleDndSettings } from "../shared/settings";

@action({ UUID: "dev.aryapaw.quickbits.toggle-dnd" })
export class ToggleDndAction extends SingletonAction<ToggleDndSettings> {
	private readonly keyPressGuard = new KeyPressGuard(DND_TOGGLE_CYCLE_MS);

	override async onWillAppear(ev: WillAppearEvent<ToggleDndSettings>): Promise<void> {
		await ev.action.setTitle("DND");
	}

	override async onKeyDown(ev: KeyDownEvent<ToggleDndSettings>): Promise<void> {
		await this.keyPressGuard.run(ev.action.id, async () => {
			const success = await toggleDnd();

			if (success) {
				await ev.action.showOk();
			} else {
				await ev.action.showAlert();
			}
		});
	}
}
