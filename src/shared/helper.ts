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

export async function runHelper(
	args: string[],
	timeoutMs = 10_000
): Promise<{ success: boolean; output: string }> {
	const helperPath = getHelperPath();

	if (!existsSync(helperPath)) {
		const error = `Helper not found: ${helperPath}`;
		streamDeck.logger.error(error);
		return { success: false, output: error };
	}

	try {
		const { stdout, stderr } = await execFileAsync(helperPath, args, {
			timeout: timeoutMs,
			windowsHide: true
		});

		const output = stdout.trim() || stderr.trim();
		streamDeck.logger.debug(`Helper executed: ${args.join(" ")} -> ${output}`);
		return { success: true, output };
	} catch (err) {
		const execErr = err as { message?: string; stdout?: string; stderr?: string };
		const output = [execErr.stdout, execErr.stderr, execErr.message]
			.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
			.map((part) => part.trim())
			.join(" | ");
		streamDeck.logger.error(`Helper error: ${output || String(err)}`);
		return { success: false, output: output || String(err) };
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

export async function recycleFileToBin(
	filePath: string,
	folderPath: string,
	maxAgeSeconds: number
): Promise<{ success: boolean; output: string }> {
	return runHelper([
		"recycle-file",
		"--path",
		filePath,
		"--folder",
		folderPath,
		"--max-age-seconds",
		String(maxAgeSeconds)
	]);
}

export async function restoreFileFromBin(
	filePath: string,
	folderPath: string
): Promise<{ success: boolean; output: string }> {
	return runHelper(["restore-file", "--path", filePath, "--folder", folderPath], 20_000);
}
