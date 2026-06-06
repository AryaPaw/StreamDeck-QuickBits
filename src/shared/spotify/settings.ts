import streamDeck from "@elgato/streamdeck";
import type { SpotifySettings } from "./types";

let globalSpotifySettings: SpotifySettings = {};

export async function loadSpotifySettings(): Promise<SpotifySettings> {
	const settings = await streamDeck.settings.getGlobalSettings<SpotifySettings>();
	globalSpotifySettings = settings || {};
	return globalSpotifySettings;
}

export async function saveSpotifySettings(settings: SpotifySettings): Promise<void> {
	globalSpotifySettings = { ...globalSpotifySettings, ...settings };
	await streamDeck.settings.setGlobalSettings(globalSpotifySettings);
}

export function getSpotifySettings(): SpotifySettings {
	return globalSpotifySettings;
}
