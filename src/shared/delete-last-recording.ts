import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_RECORDING_FOLDER = "D:\\Media\\Videos";
export const DEFAULT_MAX_AGE_SECONDS = 5;

export const VIDEO_EXTENSIONS = new Set([
	".mkv",
	".mp4",
	".mov",
	".m4v",
	".flv",
	".webm",
	".mpeg",
	".mpg",
	".ts",
	".m2ts",
	".mts",
	".avi"
]);

export type DeleteLastRecordingSettings = {
	folderPath?: string;
	maxAgeSeconds?: number;
	lastRecycledPath?: string;
};

export type RestoreRecordingFailure =
	| "no-undo"
	| "folder-missing"
	| "unsafe-path"
	| "already-exists"
	| "no-video";

export type SelectLastRecordingFailure =
	| "folder-missing"
	| "not-a-folder"
	| "no-video"
	| "too-old"
	| "unsafe-path";

export type SelectLastRecordingResult =
	| { ok: true; filePath: string; fileName: string; ageMs: number }
	| { ok: false; reason: SelectLastRecordingFailure };

export function normalizeMaxAgeSeconds(value: unknown): number {
	const parsed =
		typeof value === "number" && Number.isFinite(value)
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
	if (!Number.isFinite(parsed)) {
		return DEFAULT_MAX_AGE_SECONDS;
	}
	return Math.max(3, Math.min(120, Math.round(parsed)));
}

export function resolveRecordingFolder(folderPath?: string): string {
	const trimmed = folderPath?.trim();
	if (trimmed) {
		return path.resolve(trimmed);
	}
	return path.resolve(DEFAULT_RECORDING_FOLDER);
}

export function isVideoFileName(fileName: string): boolean {
	const ext = path.extname(fileName).toLowerCase();
	if (!VIDEO_EXTENSIONS.has(ext)) {
		return false;
	}
	return !fileName.startsWith(".") && !fileName.includes("\0");
}

export function isFileInsideDirectory(filePath: string, folderPath: string): boolean {
	const fileFull = path.resolve(filePath);
	const folderFull = path.resolve(folderPath);
	const prefix = folderFull.endsWith(path.sep) ? folderFull : `${folderFull}${path.sep}`;
	if (process.platform === "win32") {
		const fileKey = fileFull.toLowerCase();
		const prefixKey = prefix.toLowerCase();
		const folderKey = folderFull.toLowerCase();
		return fileKey.startsWith(prefixKey) && fileKey !== folderKey;
	}
	return fileFull.startsWith(prefix) && fileFull !== folderFull;
}

export function selectLastRecording(
	folderPath: string,
	nowMs: number,
	maxAgeMs: number
): SelectLastRecordingResult {
	const folderFull = path.resolve(folderPath);
	if (!existsSync(folderFull)) {
		return { ok: false, reason: "folder-missing" };
	}

	let folderStat;
	try {
		folderStat = statSync(folderFull);
	} catch {
		return { ok: false, reason: "folder-missing" };
	}
	if (!folderStat.isDirectory()) {
		return { ok: false, reason: "not-a-folder" };
	}

	let newest: { filePath: string; fileName: string; mtimeMs: number } | null = null;

	let names: string[];
	try {
		names = readdirSync(folderFull);
	} catch {
		return { ok: false, reason: "folder-missing" };
	}

	for (const name of names) {
		if (!isVideoFileName(name)) {
			continue;
		}
		const filePath = path.join(folderFull, name);
		if (!isFileInsideDirectory(filePath, folderFull)) {
			continue;
		}
		let stat;
		try {
			stat = lstatSync(filePath);
		} catch {
			continue;
		}
		if (!stat.isFile() || stat.isSymbolicLink()) {
			continue;
		}
		if (newest === null || stat.mtimeMs > newest.mtimeMs) {
			newest = { filePath, fileName: name, mtimeMs: stat.mtimeMs };
		}
	}

	if (!newest) {
		return { ok: false, reason: "no-video" };
	}
	if (!isFileInsideDirectory(newest.filePath, folderFull)) {
		return { ok: false, reason: "unsafe-path" };
	}

	const ageMs = nowMs - newest.mtimeMs;
	if (ageMs > maxAgeMs) {
		return { ok: false, reason: "too-old" };
	}

	return {
		ok: true,
		filePath: newest.filePath,
		fileName: newest.fileName,
		ageMs: Math.max(0, ageMs)
	};
}

export function statusTitleForFailure(reason: SelectLastRecordingFailure): string {
	switch (reason) {
		case "folder-missing":
			return "No folder";
		case "not-a-folder":
			return "Not folder";
		case "no-video":
			return "No video";
		case "too-old":
			return "Too old";
		case "unsafe-path":
			return "Blocked";
		default: {
			const unexpected: never = reason;
			return unexpected;
		}
	}
}

export function validateRestoreTarget(
	filePath: string | undefined,
	folderPath: string
): { ok: true; filePath: string; fileName: string } | { ok: false; reason: RestoreRecordingFailure } {
	const trimmed = filePath?.trim();
	if (!trimmed) {
		return { ok: false, reason: "no-undo" };
	}

	const folderFull = path.resolve(folderPath);
	if (!existsSync(folderFull)) {
		return { ok: false, reason: "folder-missing" };
	}
	try {
		if (!statSync(folderFull).isDirectory()) {
			return { ok: false, reason: "folder-missing" };
		}
	} catch {
		return { ok: false, reason: "folder-missing" };
	}

	const fileFull = path.resolve(trimmed);
	if (!isFileInsideDirectory(fileFull, folderFull)) {
		return { ok: false, reason: "unsafe-path" };
	}
	if (!isVideoFileName(path.basename(fileFull))) {
		return { ok: false, reason: "no-video" };
	}

	if (existsSync(fileFull)) {
		return { ok: false, reason: "already-exists" };
	}

	return { ok: true, filePath: fileFull, fileName: path.basename(fileFull) };
}

export function statusTitleForRestoreFailure(reason: RestoreRecordingFailure): string {
	switch (reason) {
		case "no-undo":
			return "No undo";
		case "folder-missing":
			return "No folder";
		case "unsafe-path":
			return "Blocked";
		case "already-exists":
			return "Exists";
		case "no-video":
			return "No video";
		default: {
			const unexpected: never = reason;
			return unexpected;
		}
	}
}
