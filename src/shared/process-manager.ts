import { spawn } from "node:child_process";
import streamDeck from "@elgato/streamdeck";

export class ProcessManager {
	/**
	 * Starts a process detached from the Stream Deck plugin process.
	 * @param exePath Full path to executable
	 * @param options.windowsHide Hide console window on Windows (default true). Use false for short-lived GUI triggers that need foreground.
	 */
	async startDetachedProcess(
		exePath: string,
		options?: { windowsHide?: boolean }
	): Promise<boolean> {
		if (!exePath || exePath.trim().length === 0) {
			streamDeck.logger.error("[ProcessManager] startDetachedProcess: empty path");
			return false;
		}

		const windowsHide = options?.windowsHide ?? true;

		return new Promise((resolve) => {
			let settled = false;
			const finish = (ok: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(ok);
			};

			try {
				const child = spawn(exePath, [], {
					detached: true,
					stdio: "ignore",
					windowsHide
				});

				child.once("error", (err: Error) => {
					streamDeck.logger.error(`[ProcessManager] startDetachedProcess spawn error: ${err}`);
					finish(false);
				});

				child.once("spawn", () => {
					child.unref();
					streamDeck.logger.info(`[ProcessManager] Started detached process: ${exePath}`);
					finish(true);
				});
			} catch (err) {
				streamDeck.logger.error(`[ProcessManager] startDetachedProcess error: ${err}`);
				finish(false);
			}
		});
	}

	/**
	 * Starts a minimal WinForms trigger exe (foreground-capable). Does not use windowsHide so the GUI can activate.
	 */
	async startGuiTriggerProcess(exePath: string): Promise<boolean> {
		return this.startDetachedProcess(exePath, { windowsHide: false });
	}
}

export const processManager = new ProcessManager();
