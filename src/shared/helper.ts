import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import streamDeck from "@elgato/streamdeck";

const execFileAsync = promisify(execFile);

const HELPER_NAME = "QuickbitsHelper.exe";

function getHelperPath(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	return join(currentDir, "..", "helper", HELPER_NAME);
}

export async function runHelper(args: string[]): Promise<{ success: boolean; output: string }> {
	const helperPath = getHelperPath();

	if (!existsSync(helperPath)) {
		const error = `Helper not found: ${helperPath}`;
		streamDeck.logger.error(error);
		return { success: false, output: error };
	}

	try {
		const { stdout, stderr } = await execFileAsync(helperPath, args, {
			timeout: 10000,
			windowsHide: true
		});

		const output = stdout.trim() || stderr.trim();
		streamDeck.logger.debug(`Helper executed: ${args.join(" ")} -> ${output}`);
		return { success: true, output };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		streamDeck.logger.error(`Helper error: ${message}`);
		return { success: false, output: message };
	}
}

export async function setVolume(percent: number): Promise<boolean> {
	const result = await runHelper(["set-volume", "--percent", String(percent)]);
	return result.success;
}

export async function toggleDnd(): Promise<boolean> {
	const result = await runHelper(["toggle-dnd"]);
	return result.success;
}
