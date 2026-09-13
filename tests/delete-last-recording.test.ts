import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	isFileInsideDirectory,
	isVideoFileName,
	normalizeMaxAgeSeconds,
	resolveRecordingFolder,
	selectLastRecording,
	statusTitleForFailure,
	statusTitleForRestoreFailure,
	validateRestoreTarget,
	DEFAULT_RECORDING_FOLDER
} from "../src/shared/delete-last-recording";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "qb-rec-"));
	dirs.push(dir);
	return dir;
}

function touch(filePath: string, ageSecondsAgo: number, nowMs: number): void {
	writeFileSync(filePath, "video");
	const at = new Date(nowMs - ageSecondsAgo * 1000);
	utimesSync(filePath, at, at);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("normalizeMaxAgeSeconds", () => {
	test("defaults and clamps", () => {
		expect(normalizeMaxAgeSeconds(undefined)).toBe(5);
		expect(normalizeMaxAgeSeconds("5")).toBe(5);
		expect(normalizeMaxAgeSeconds(1)).toBe(3);
		expect(normalizeMaxAgeSeconds(999)).toBe(120);
	});
});

describe("resolveRecordingFolder", () => {
	test("uses OBS folder when unset", () => {
		expect(resolveRecordingFolder()).toBe(path.resolve(DEFAULT_RECORDING_FOLDER));
		expect(resolveRecordingFolder("  ")).toBe(path.resolve(DEFAULT_RECORDING_FOLDER));
	});

	test("honors a custom folder", () => {
		expect(resolveRecordingFolder("E:\\Clips")).toBe(path.resolve("E:\\Clips"));
	});
});

describe("isVideoFileName", () => {
	test("allows OBS-like names and rejects others", () => {
		expect(isVideoFileName("2026-09-09 15-00-00.mkv")).toBe(true);
		expect(isVideoFileName("clip.MP4")).toBe(true);
		expect(isVideoFileName("notes.txt")).toBe(false);
		expect(isVideoFileName(".hidden.mkv")).toBe(false);
		expect(isVideoFileName("folder")).toBe(false);
	});
});

describe("isFileInsideDirectory", () => {
	test("accepts files in the folder and rejects prefix lookalikes", () => {
		const folder = "D:\\Media\\Videos";
		expect(isFileInsideDirectory("D:\\Media\\Videos\\clip.mkv", folder)).toBe(true);
		expect(isFileInsideDirectory("D:\\Media\\Videos\\nested\\clip.mkv", folder)).toBe(true);
		expect(isFileInsideDirectory("D:\\Media\\VideosExtra\\clip.mkv", folder)).toBe(false);
		expect(isFileInsideDirectory("D:\\Media\\Videos", folder)).toBe(false);
		expect(isFileInsideDirectory("D:\\Other\\clip.mkv", folder)).toBe(false);
	});

	test("rejects path traversal after resolve", () => {
		const folder = path.join("D:", "Media", "Videos");
		expect(isFileInsideDirectory(path.join(folder, "..", "Windows", "clip.mkv"), folder)).toBe(false);
	});
});

describe("selectLastRecording", () => {
	test("picks the newest video by last write time", () => {
		const dir = tempDir();
		const now = Date.now();
		touch(path.join(dir, "older.mkv"), 8, now);
		touch(path.join(dir, "newest.mkv"), 1, now);
		touch(path.join(dir, "readme.txt"), 0, now);

		const result = selectLastRecording(dir, now, 10_000);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.fileName).toBe("newest.mkv");
		}
	});

	test("does not select a video older than max age", () => {
		const dir = tempDir();
		const now = Date.now();
		touch(path.join(dir, "stale.mkv"), 11, now);

		const result = selectLastRecording(dir, now, 10_000);
		expect(result).toEqual({ ok: false, reason: "too-old" });
	});

	test("ignores a newer non-video so an old recording is not deleted", () => {
		const dir = tempDir();
		const now = Date.now();
		touch(path.join(dir, "old-take.mkv"), 40, now);
		touch(path.join(dir, "notes.txt"), 1, now);

		expect(selectLastRecording(dir, now, 10_000)).toEqual({ ok: false, reason: "too-old" });
	});

	test("does not look in subfolders", () => {
		const dir = tempDir();
		const nested = path.join(dir, "other");
		mkdirSync(nested);
		const now = Date.now();
		touch(path.join(nested, "nested.mkv"), 1, now);

		expect(selectLastRecording(dir, now, 10_000)).toEqual({ ok: false, reason: "no-video" });
	});

	test("returns folder-missing for a path that does not exist", () => {
		const missing = path.join(tempDir(), "nope");
		expect(selectLastRecording(missing, Date.now(), 10_000)).toEqual({
			ok: false,
			reason: "folder-missing"
		});
	});

	test("returns not-a-folder when path is a file", () => {
		const dir = tempDir();
		const file = path.join(dir, "file.mkv");
		writeFileSync(file, "x");
		expect(selectLastRecording(file, Date.now(), 10_000)).toEqual({ ok: false, reason: "not-a-folder" });
	});
});

describe("validateRestoreTarget", () => {
	test("rejects empty undo and paths outside the folder", () => {
		const dir = tempDir();
		expect(validateRestoreTarget(undefined, dir)).toEqual({ ok: false, reason: "no-undo" });
		expect(validateRestoreTarget("D:\\Other\\clip.mkv", dir)).toEqual({
			ok: false,
			reason: "unsafe-path"
		});
	});

	test("rejects a restore that would overwrite an existing file", () => {
		const dir = tempDir();
		const file = path.join(dir, "clip.mkv");
		writeFileSync(file, "x");
		expect(validateRestoreTarget(file, dir)).toEqual({ ok: false, reason: "already-exists" });
	});

	test("accepts a missing video that still belongs to the folder", () => {
		const dir = tempDir();
		const file = path.join(dir, "clip.mkv");
		const result = validateRestoreTarget(file, dir);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.fileName).toBe("clip.mkv");
		}
	});
});

describe("statusTitleForFailure", () => {
	test("maps every failure to a short key title", () => {
		expect(statusTitleForFailure("too-old")).toBe("Too old");
		expect(statusTitleForFailure("no-video")).toBe("No video");
		expect(statusTitleForFailure("folder-missing")).toBe("No folder");
		expect(statusTitleForFailure("not-a-folder")).toBe("Not folder");
		expect(statusTitleForFailure("unsafe-path")).toBe("Blocked");
	});
});

describe("statusTitleForRestoreFailure", () => {
	test("maps restore failures", () => {
		expect(statusTitleForRestoreFailure("no-undo")).toBe("No undo");
		expect(statusTitleForRestoreFailure("already-exists")).toBe("Exists");
		expect(statusTitleForRestoreFailure("unsafe-path")).toBe("Blocked");
	});
});
