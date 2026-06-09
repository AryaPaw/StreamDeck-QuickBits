# StreamDeck QuickBits

Stream Deck plugin with small Windows-focused utilities: system volume, Do Not Disturb, Skydimo lighting triggers, and Spotify controls (local playback + optional Web API for Like).

**Plugin ID:** `dev.aryapaw.quickbits`
**Current version:** see [`dev.aryapaw.quickbits.sdPlugin/manifest.json`](dev.aryapaw.quickbits.sdPlugin/manifest.json)

## Requirements

- [Stream Deck](https://www.elgato.com/stream-deck) 6.9+
- Windows 10+
- [Bun](https://bun.sh) (build scripts)
- [.NET SDK 8](https://dotnet.microsoft.com/download) (helper + Skydimo triggers)
- [Stream Deck CLI](https://docs.elgato.com/streamdeck/cli/) (`streamdeck` on PATH) for local install/restart

## Actions

| Action | Description |
|--------|-------------|
| Set Volume | Set system volume to a configured percentage |
| Toggle DND | Toggle Windows Focus Assist / Do Not Disturb |
| Skydimo: lighting | Launch Skydimo trigger apps (sync / static / off) |
| Spotify: Setup | OAuth + Spotify Developer app credentials |
| Spotify: Now Playing | Album art + play/pause (GSMTC, no Web API) |
| Spotify: Previous / Next | Skip tracks via local media session |
| Spotify: Like | Like/unlike via Spotify Web API (requires Setup) |

### Spotify architecture

- **Playback & artwork:** Windows GSMTC through `QuickbitsHelper.exe` (local-first, like the official Elgato Spotify plugin).
- **Like / library:** Spotify Web API only when the Like action is on the deck.
- **Debug:** `http://127.0.0.1:5789/debug` (API metrics, localhost only) after the plugin is running.

## Project layout

```
src/                          TypeScript plugin sources
helper/                       QuickbitsHelper.exe (.NET, GSMTC daemon)
triggers/                     Skydimo WinForms trigger apps
dev.aryapaw.quickbits.sdPlugin/
  manifest.json               Version + action definitions
  ui/                         Property Inspectors
  web/                        Setup + debug pages
  imgs/                       Action icons (SVG)
scripts/                      Build/deploy PowerShell helpers
```

Runtime cache (not in git): `%APPDATA%\Elgato\StreamDeck\Plugins\dev.aryapaw.quickbits.sdPlugin\cache\`

## Build

```powershell
bun install
bun run build              # helper + triggers + plugin
bun run build:plugin       # TypeScript only
bun run build:helper       # QuickbitsHelper only
bun run build:triggers     # Skydimo triggers only
```

## Install for development

Link the plugin folder into Stream Deck and restart:

```powershell
bun run link:deck
```

Or build manually, then:

```powershell
streamdeck restart dev.aryapaw.quickbits
```

Installed plugin path:

`%APPDATA%\Elgato\StreamDeck\Plugins\dev.aryapaw.quickbits.sdPlugin\`

Plugin logs:

`%APPDATA%\Elgato\StreamDeck\Plugins\dev.aryapaw.quickbits.sdPlugin\logs\dev.aryapaw.quickbits.0.log`

## Spotify Setup

1. Add **Spotify: Setup** to the deck and open the setup page (or visit `http://127.0.0.1:5789/` while the plugin runs).
2. Create a Spotify Developer app named **StreamDeck QuickBits**.
3. Set redirect URI: `http://127.0.0.1:5789/callback`
4. Enable **Web API** scopes used by Like: `user-library-read`, `user-library-modify`.

Credentials are stored in Stream Deck global settings (not committed to git).

## Versioning

Bump the patch segment in `dev.aryapaw.quickbits.sdPlugin/manifest.json` (`0.1.0.N`) for functional changes before release.

## License

[MIT](LICENSE) — free to use, modify, and distribute.
