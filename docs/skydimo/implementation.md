# Skydimo lighting — implementation notes

User-facing setup: [README](../../README.md#skydimo-lighting).

The Stream Deck action launches short-lived WinForms helpers so Skydimo can match **App is running**:

| Helper | Window title |
|--------|----------------|
| `SkydimoTrigger.ScreenSync.exe` | QuickBits Skydimo ScreenSync |
| `SkydimoTrigger.ScreenStatic.exe` | QuickBits Skydimo Static |
| `SkydimoTrigger.LightingOff.exe` | QuickBits Skydimo LightingOff |

Key state (`lightingMode`) is the last trigger the plugin fired, not live Skydimo mode.

On Windows, if `C:\Program Files\Skydimo\Skydimo.exe` exists, the plugin waits for that process (up to 3 minutes) and fires Static once. Other install paths skip bootstrap.

Code: `src/actions/skydimo-lighting-toggle.ts`, `src/shared/skydimo-startup-static.ts`, `src/shared/skydimo-trigger-registry.ts`, `triggers/SkydimoTrigger.*`.
