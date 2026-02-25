# Android Web Mirror

Android emulator mirroring + control in a browser (local-first POC).

This project runs 3 local processes:
1. `signaling`: session tokens, lock arbitration, WebSocket relay.
2. `agent`: captures emulator frames via `adb` and injects control events.
3. `web`: browser UI for viewing and controlling the emulator.

## Prerequisites

- Node.js 20+
- Android SDK platform tools (`adb`) installed
- Running Android emulator (default serial `emulator-5554`)

## Quick Start (PowerShell)

```powershell
cd C:\development\android-browser-mirror-poc
npm install
```

Open 3 terminals in the project:

Terminal 1:

```powershell
npm run dev:signaling
```

Terminal 2:

```powershell
$env:Path = "C:\Users\cwong\AppData\Local\Android\Sdk\platform-tools;$env:Path"
$env:ADB_SERIAL = "emulator-5554"
adb devices
npm run dev:agent
```

Terminal 3:

```powershell
npm run dev:web
```

When the agent starts, it prints:
- `controller` URL
- `viewer` URL

Open the `controller` URL to interact with the emulator.

## Local Environment Variables

### Signaling

- `PORT` (default: `8787`)
- `WEB_ORIGIN` (default: `http://localhost:5173`)
- `SESSION_SIGNING_KEY` (default: `dev-only-secret`)
- `SESSION_DEFAULT_TTL_SEC` (default: `3600`)

### Agent

- `SIGNALING_BASE_URL` (default: `http://localhost:8787`)
- `ADB_SERIAL` (default: `emulator-5554`)
- `FRAME_INTERVAL_MS` (default: `120`)
- `AUTO_CREATE_SESSION` (default: `true`)

If `AUTO_CREATE_SESSION=false`, set all of:
- `SESSION_ID`
- `AGENT_TOKEN`
- `CONTROLLER_TOKEN`
- `VIEWER_TOKEN`
- `WEB_ORIGIN` (optional, default `http://localhost:5173`)

## Smoke Tests

1. Start all processes and verify signaling `GET /api/dev/health` returns `ok: true`.
2. Open controller URL and verify live emulator frames appear.
3. Tap and swipe in the viewer and confirm emulator responds.
4. Use Back/Home/Recent buttons.
5. Open viewer URL in second tab and request/release control lock.

## Troubleshooting

`Error: spawn adb ENOENT`
- `adb` is not on your current terminal `PATH`.
- In PowerShell, run:

```powershell
$env:Path = "C:\Users\cwong\AppData\Local\Android\Sdk\platform-tools;$env:Path"
adb version
```

`session id and token are required`
- You opened `http://localhost:5173` directly.
- Use the full `controller` URL printed by the agent, which includes `sessionId` and `token`.

No frames appear
- Verify emulator is running and listed by `adb devices`.
- Confirm signaling is up at `http://localhost:8787/api/dev/health`.
- Restart the agent after emulator is ready.

## Current Limitations

- Transport is WS+PNG frames for local POC simplicity.
- No audio.
- Emulator-focused (via `adb`), not physical-device optimized.
- No cloud deployment in this code yet.

## Next Step to Match Full Plan

- Replace frame relay with WebRTC media track path while preserving existing session/token/control APIs.
