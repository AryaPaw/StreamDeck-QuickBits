const HEART_PATH =
	"M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z";

export type PlaylistLikeVisual = "empty" | "liked" | "pending" | "unavailable";

const imageCache = new Map<string, string>();

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function wrapLabel(text: string, maxLen = 11, maxLines = 2): string[] {
	const trimmed = text.trim();
	if (!trimmed) {
		return ["Playlist"];
	}
	if (trimmed.length <= maxLen) {
		return [trimmed];
	}

	const words = trimmed.split(/\s+/);
	const lines: string[] = [];
	let current = "";

	const pushTruncated = (value: string): void => {
		lines.push(value.length > maxLen ? `${value.slice(0, maxLen - 1)}…` : value);
	};

	for (const word of words) {
		if (lines.length >= maxLines) {
			break;
		}
		const next = current ? `${current} ${word}` : word;
		if (next.length <= maxLen) {
			current = next;
			continue;
		}
		if (current) {
			lines.push(current);
			current = "";
		}
		if (lines.length >= maxLines) {
			break;
		}
		pushTruncated(word);
		if (lines.length >= maxLines) {
			current = "";
		}
	}
	if (current && lines.length < maxLines) {
		lines.push(current);
	}
	if (lines.length === maxLines && trimmed.length > lines.join(" ").length) {
		const last = lines[maxLines - 1];
		if (!last.endsWith("…") && last.length >= maxLen) {
			lines[maxLines - 1] = `${last.slice(0, maxLen - 1)}…`;
		}
	}
	return lines.length > 0 ? lines : ["Playlist"];
}

function heartMarkup(visual: PlaylistLikeVisual): string {
	const heart = `<g transform="translate(72,68) scale(3.55) translate(-12,-11.5)">`;
	switch (visual) {
		case "liked":
			return `${heart}<path fill="#1DB954" d="${HEART_PATH}"/></g>`;
		case "pending":
			return `${heart}<path fill="none" stroke="#1DB954" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" d="${HEART_PATH}"/></g>`;
		case "unavailable":
			return `<g transform="translate(72,68) scale(3.55) translate(-12,-11.5)" opacity="0.35"><path fill="none" stroke="#9a9a9a" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" d="${HEART_PATH}"/></g><circle cx="102" cy="92" r="20" fill="#c45c26"/><path d="M102 81v16" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/><circle cx="102" cy="104" r="3.2" fill="#ffffff"/>`;
		case "empty":
			return `${heart}<path fill="none" stroke="#ececec" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" d="${HEART_PATH}"/></g>`;
		default: {
			const _never: never = visual;
			return _never;
		}
	}
}

function titleMarkup(lines: string[]): string {
	const startY = lines.length === 1 ? 124 : 114;
	return lines
		.map((line, index) => {
			const y = startY + index * 18;
			return `<text x="72" y="${y}" text-anchor="middle" fill="#ececec" font-size="20" font-weight="600" font-family="Segoe UI, Arial, sans-serif">${escapeXml(line)}</text>`;
		})
		.join("");
}

export function buildPlaylistLikeKeyImage(title: string, visual: PlaylistLikeVisual): string {
	const lines = wrapLabel(title);
	const cacheKey = `${visual}:${lines.join("\n")}`;
	const cached = imageCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const svg = `<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg">${heartMarkup(visual)}${titleMarkup(lines)}</svg>`;
	const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	imageCache.set(cacheKey, image);
	if (imageCache.size > 80) {
		const oldest = imageCache.keys().next().value;
		if (oldest) {
			imageCache.delete(oldest);
		}
	}
	return image;
}
