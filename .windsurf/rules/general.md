---
trigger: always
---

# QuickBits — Stream Deck Plugin

## Project Structure

- **TypeScript plugin**: `src/` → builds to `dev.aryapaw.quickbits.sdPlugin/bin/plugin.js`
- **C# helper**: `helper/` → publishes to `dev.aryapaw.quickbits.sdPlugin/helper/QuickbitsHelper.exe`
- **Property Inspector**: `dev.aryapaw.quickbits.sdPlugin/ui/` (uses sdpi-components.js locally)
- **Icons**: `dev.aryapaw.quickbits.sdPlugin/imgs/`

## Tech Stack

- Stream Deck SDK 2.x with TypeScript decorators (`@elgato/streamdeck`)
- Rollup for bundling
- .NET 8 for Windows-specific helper (self-contained single-file publish)
- sdpi-components for Property Inspector UI (local copy, NOT npm)

## Build Commands

- `bun run build` — full build (helper + plugin)
- `bun run build:helper` — only C# helper
- `bun run build:plugin` — only TypeScript plugin
- `bun run watch` — dev mode with hot reload

## Key Conventions

1. **ES Modules**: Use `import.meta.url` instead of `__dirname`
2. **Helper communication**: Via `child_process.execFile`, returns `{ success, output }`
3. **Settings persistence**: Use sdpi-components with `setting` attribute for auto-persistence
4. **Icons**: SVG format, placed in `imgs/actions/{action-name}/`
5. **Manifest**: `dev.aryapaw.quickbits.sdPlugin/manifest.json`

## Actions

| Action     | UUID                                 | Settings          |
| ---------- | ------------------------------------ | ----------------- |
| Set Volume | `dev.aryapaw.quickbits.set-volume`   | `percent: number` |
| Toggle DND | `dev.aryapaw.quickbits.toggle-dnd`   | none              |

## Helper Commands

```bash
QuickbitsHelper.exe set-volume --percent <0-100>
QuickbitsHelper.exe toggle-dnd
```

## Windows APIs Used

- **Volume**: Core Audio API (IMMDeviceEnumerator, IAudioEndpointVolume)
- **Keyboard simulation**: `keybd_event` for reliable background input
- **DND**: UI macro (Win+N, Enter, Esc)

## Important Notes

- Helper must be self-contained (`SelfContained=true`) to avoid DLL dependencies
- Use `keybd_event` instead of `SendInput` for background processes
- Volume flyout: press VolumeDown then VolumeUp to trigger system UI
