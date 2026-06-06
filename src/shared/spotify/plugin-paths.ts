import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getPluginRoot(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	return join(currentDir, "..");
}

export function resolveArtworkPath(pathOrRelative: string): string | null {
	if (existsSync(pathOrRelative)) {
		return pathOrRelative;
	}

	const absolute = join(getPluginRoot(), pathOrRelative);
	return existsSync(absolute) ? absolute : null;
}
