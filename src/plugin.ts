import streamDeck from "@elgato/streamdeck";

import { SetVolumeAction } from "./actions/set-volume";
import { ToggleDndAction } from "./actions/toggle-dnd";

streamDeck.logger.setLevel("debug");

streamDeck.actions.registerAction(new SetVolumeAction());
streamDeck.actions.registerAction(new ToggleDndAction());

streamDeck.connect();
