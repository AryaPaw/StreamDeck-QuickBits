# Skydimo lighting (QuickBits)

## Overview

The **Skydimo: lighting (foreground triggers)** action runs **short-lived WinForms apps** that briefly become the foreground window so Skydimo can match **Application Foreground** or **Foreground Title Contains** rules when *Application Launch / Close* or *process exists* rules do not work on your PC.

- **ON (Screen Sync):** `SkydimoTrigger.ScreenSync.exe` (title contains `QuickBits Skydimo ScreenSync`).
- **OFF (Static):** `SkydimoTrigger.ScreenStatic.exe` (title contains `QuickBits Skydimo Static`).
- Each trigger exits automatically after a fraction of a second; no persistent marker process.
- **Button state** is stored in action settings (`screenSyncActive`). It reflects the **last successful trigger you fired**, not a live read of Skydimo’s internal mode (Skydimo has no documented API for that).

If you change lighting only outside Stream Deck, the key may be out of sync until you press it once to realign.

## Build

```bash
bun run build
```

Triggers are copied to `dev.aryapaw.quickbits.sdPlugin/triggers/`.

## Configure in Stream Deck

1. Add **Skydimo: lighting (foreground triggers)** after a full build so both `.exe` files exist under the plugin folder.
2. No Property Inspector settings.
3. Test: first press → Screen Sync trigger; second press → Static trigger. Key uses `setImage` + title (`Sync` / `Static`).

## Skydimo 2.1.4 automation (foreground triggers)

**Goal:** Skydimo switches profiles when the corresponding **trigger app** becomes foreground.

1. **Skydimo Settings** → Automation  
2. **Rule A — Screen Sync:** Application Foreground or Foreground Title Contains → match `SkydimoTrigger.ScreenSync.exe` and/or `QuickBits Skydimo ScreenSync` → action: your Screen Sync profile.  
3. **Rule B — Static:** same for `SkydimoTrigger.ScreenStatic.exe` / `QuickBits Skydimo Static` → your Static profile.  
4. Press the Stream Deck key twice; each press should briefly foreground one trigger.

**Note:** If you toggle quickly, both rules may fire in sequence; usually the **last** foreground event wins.

## Limitations

- **Windows only** (trigger exes are .NET WinForms).
- **No live Skydimo state** in the plugin — icon/title follow last successful trigger only.
- Rapid presses can be **debounced**; extra presses within the window may be ignored.

## Troubleshooting

- **Skydimo not switching:** confirm rule match strings, that rules are enabled, and that `bun run build` placed exes under `triggers/` in the installed plugin folder.
- **Logs:** `%APPDATA%\Elgato\StreamDeck\logs`

## Code layout

- `src/actions/skydimo-lighting-toggle.ts` — action
- `src/shared/skydimo-trigger-registry.ts` — paths to bundled exes
- `src/shared/process-manager.ts` — detached `spawn` for triggers
- `triggers/SkydimoTrigger.ScreenSync/`, `triggers/SkydimoTrigger.ScreenStatic/` — C# projects
