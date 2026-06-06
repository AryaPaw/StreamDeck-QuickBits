# Skydimo lighting (QuickBits)

## Overview

The **Skydimo: lighting (foreground triggers)** action runs **short-lived WinForms apps** that briefly become the
foreground window so Skydimo can match **Application Foreground** or **Foreground Title Contains** rules when
_Application Launch / Close_ or _process exists_ rules do not work on your PC.

- **Screen Sync:** `SkydimoTrigger.ScreenSync.exe` (title contains `QuickBits Skydimo ScreenSync`).
- **Static:** `SkydimoTrigger.ScreenStatic.exe` (title contains `QuickBits Skydimo Static`).
- **Lighting off:** `SkydimoTrigger.LightingOff.exe` (title contains `QuickBits Skydimo LightingOff`) — fired on **long
  press**; configure a **third** Skydimo profile (fully off or separate from Static).
- Each trigger exits automatically after a fraction of a second; no persistent marker process.
- **Button state** is stored in action settings (`lightingMode`: `sync` | `static` | `off`, plus legacy
  `screenSyncActive` for older profiles). It reflects the **last successful trigger you fired**, not a live read of
  Skydimo’s internal mode (Skydimo has no documented API for that).

If you change lighting only outside Stream Deck, the key may be out of sync until you press it once to realign.

## Build

```bash
bun run build
```

Triggers are copied to `dev.aryapaw.quickbits.sdPlugin/triggers/`.

## Configure in Stream Deck

1. Add **Skydimo: lighting (foreground triggers)** after a full build so all three `.exe` files exist under the plugin
   folder.
2. No Property Inspector settings.
3. **Short tap:** toggles Sync ↔ Static; from **Off**, the next short tap goes to **Static**. **Long hold** (~650 ms):
   Lighting Off trigger.

## Startup (plugin load)

On **Windows**, if `C:\Program Files\Skydimo\Skydimo.exe` exists, the plugin waits until **Skydimo.exe** appears in the
process list (poll every 2 s, **timeout 3 minutes**). When it does, the **Static** foreground trigger runs once and all
**visible** Skydimo lighting keys are set to **Static** in saved settings. If the default exe path is missing (e.g.
portable install elsewhere), this bootstrap is **skipped** entirely.

## Skydimo 2.1.4 automation (foreground triggers)

**Goal:** Skydimo switches profiles when the corresponding **trigger app** becomes foreground.

1. **Skydimo Settings** → Automation
2. **Rule A — Screen Sync:** Application Foreground or Foreground Title Contains → match `SkydimoTrigger.ScreenSync.exe`
   and/or `QuickBits Skydimo ScreenSync` → action: your Screen Sync profile.
3. **Rule B — Static:** same for `SkydimoTrigger.ScreenStatic.exe` / `QuickBits Skydimo Static` → your Static profile.
4. **Rule C — Off:** same for `SkydimoTrigger.LightingOff.exe` / `QuickBits Skydimo LightingOff` → your Off (or blackout)
   profile.
5. Press the key: short taps alternate Sync/Static; long press should briefly foreground the Lighting Off exe.

**Note:** If you toggle quickly, multiple rules may fire in sequence; usually the **last** foreground event wins.

## Limitations

- **Windows only** (trigger exes are .NET WinForms).
- **No live Skydimo state** in the plugin — icon/title follow last successful trigger only.
- Rapid presses can be **debounced**; extra presses within the window may be ignored.

## Troubleshooting

- **Skydimo not switching:** confirm rule match strings, that rules are enabled, and that `bun run build` placed exes
  under `triggers/` in the installed plugin folder.
- **Logs:** `%APPDATA%\Elgato\StreamDeck\logs`

## Code layout

- `src/actions/skydimo-lighting-toggle.ts` — action
- `src/shared/skydimo-startup-static.ts` — wait for Skydimo.exe, static trigger on plugin connect
- `src/shared/skydimo-trigger-registry.ts` — paths to bundled exes
- `src/shared/process-manager.ts` — detached `spawn` for triggers
- `triggers/SkydimoTrigger.ScreenSync/`, `SkydimoTrigger.ScreenStatic/`, `SkydimoTrigger.LightingOff/` — C# projects
