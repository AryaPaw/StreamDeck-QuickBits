import streamDeck from "@elgato/streamdeck";

import { SetVolumeAction } from "./actions/set-volume";
import { ToggleDndAction } from "./actions/toggle-dnd";
import { SkydimoLightingToggleAction } from "./actions/skydimo-lighting-toggle";
import { runSkydimoStartupStaticBootstrap } from "./shared/skydimo-startup-static";
import { SpotifySetupAction } from "./actions/spotify-setup";
import { SpotifyNowPlayingAction } from "./actions/spotify-now-playing";
import { SpotifyPreviousAction } from "./actions/spotify-previous";
import { SpotifyNextAction } from "./actions/spotify-next";
import { SpotifyLikeAction } from "./actions/spotify-like";
import { loadSpotifySettings } from "./shared/spotify";

streamDeck.actions.registerAction(new SetVolumeAction());
streamDeck.actions.registerAction(new ToggleDndAction());
const skydimoLightingAction = new SkydimoLightingToggleAction();
streamDeck.actions.registerAction(skydimoLightingAction);
streamDeck.actions.registerAction(new SpotifySetupAction());
streamDeck.actions.registerAction(new SpotifyNowPlayingAction());
streamDeck.actions.registerAction(new SpotifyPreviousAction());
streamDeck.actions.registerAction(new SpotifyNextAction());
streamDeck.actions.registerAction(new SpotifyLikeAction());

// Load Spotify settings after connect
streamDeck.connect().then(() => {
	loadSpotifySettings();
	void runSkydimoStartupStaticBootstrap(skydimoLightingAction);
});
