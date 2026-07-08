# XGEN Connector

A desktop **connector** for [XGEN](https://github.com/PlateerLab) — set your XGEN
server URL, log in, browse **your agents** (the "Agent 목록"), and **chat** with
any of them with live streaming. Built as an Electron app with a small,
framework-agnostic transport core.

It is **node-agnostic**: it works with every XGEN agent node type —
`agent_geny`, `agent_xgen`, `agent_harness` — because it drives the single XGEN
agent execution stream. Avatar/overlay support is intentionally left as an
**extension point** for a future release (see `AvatarSlot`).

> XGEN itself is a private product; this connector is the public client that
> talks to a deployed XGEN instance over its HTTP gateway.

## Download

Grab an installer from the [**Releases**](https://github.com/PlateerLab/xgen-connector/releases/latest) page:

| OS | File | Install |
|---|---|---|
| Windows | `XGEN-Connector-Setup-*.exe` | Run it → if SmartScreen appears, **More info → Run anyway** (unsigned). |
| macOS | `XGEN-Connector-*.dmg` | Open, drag **XGEN Connector.app** to **Applications** → first launch **right-click → Open**. If it says *"damaged"*, run `xattr -dr com.apple.quarantine "/Applications/XGEN Connector.app"`. |
| Linux | `XGEN-Connector-*.AppImage` / `*.deb` | AppImage: `chmod +x` then run · deb: `sudo dpkg -i`. |

The app auto-updates from these releases (toggle in Settings). On first launch,
enter your **XGEN server URL** and **account**, then pick an agent and chat.

## Features

- **Server URL setup** — point the connector at any XGEN gateway
  (`https://xgen.example.com`); pre-seed with the `XGEN_SERVER_URL` env var.
- **Login** — email + password (password is SHA-256-hashed client-side, as XGEN
  requires). The JWT is stored in the **OS keychain** (Keychain / Credential
  Manager / libsecret), never in a plaintext file. Sessions are restored and
  refreshed automatically across restarts.
- **Agent list** — your agents, paged/searchable, filter by 개인/공유, exactly
  like the XGEN grid.
- **Chat** — pick an agent and chat with live token streaming, tool-activity
  chips, and multi-turn continuity (one conversation id per session).
- **Auto-update** — via GitHub Releases (`electron-updater`); toggle in settings.
- **Settings** — server URL, theme (system/light/dark), auto-update.
- **Floating avatar overlay** — a Geny-style transparent, always-on-top,
  click-through window that floats an **avatar + a visual-novel speech bubble**
  of what the agent is saying over your desktop. **Locked** by default
  (click-through; only a small lock chip is interactive); **unlock** to reveal a
  dashed resize frame (8 handles + "크기 조절") and a bar with just lock + delete.
  Dragging is DPI-safe (`setPosition`, so it never grows on 150%-scaled displays).
  Toggle from the sidebar (bot icon) or Settings. TTS / STT / screen-capture are
  intentionally excluded.
- **Quick chat** — a Spotlight-style floating input bar summoned by a global
  hotkey (`Ctrl/Cmd+Shift+Enter`); type + Enter relays the message into the
  active agent's chat. Enable it in Settings.
- **Avatar extension point** — `setAvatarRenderer()` mounts a future avatar into
  the overlay, bound to the active agent + its streamed text. Until then a branded
  placeholder avatar shows.

## Architecture

```
src/
  core/        # framework-agnostic transport (no Electron/React) — unit-tested
    client.ts    HttpClient: base URL + Bearer + JSON/stream helpers
    auth.ts      login / validate-token / refresh / logout
    agents.ts    GET /api/agentflow/list/detail (paged)
    chat.ts      POST /api/agentflow/execute/based-id/stream → normalized events
    sse.ts       incremental SSE frame parser
    history.ts   io-logs + interaction list
    index.ts     XgenClient facade
  main/        # Electron main: window, connector.json config, keychain, updater, IPC
  preload/     # contextBridge → window.xgen (the only renderer↔native surface)
  renderer/    # React UI: ServerSetup → Login → Workspace(agent list + Chat)
```

The transport core lives in the **main process** (Node fetch), so tokens and
network calls never touch the renderer. The renderer reaches XGEN only through
the typed `window.xgen` bridge.

## XGEN API used

| Purpose | Endpoint |
|---|---|
| Login | `POST /api/auth/login` `{email, password: sha256(pw), token:null}` |
| Session/identity | `POST /api/auth/validate-token`, `POST /api/auth/refresh` |
| Agent list | `GET /api/agentflow/list/detail?page&page_size&search&owner` |
| Chat (SSE) | `POST /api/agentflow/execute/based-id/stream` → `text/event-stream` |
| History | `GET /api/chat/io-logs`, `GET /api/interaction/list` |

All authenticated calls send `Authorization: Bearer <access_token>` (including
the SSE stream). Continue a conversation by reusing the same `interaction_id`.

The chat SSE stream is normalized into a single `ChatEvent` union:
`text` · `tool` · `node_status` · `execution_io` · `summary` · `error` · `end`
(plus `log` / `ui_command` / `download` / `quota`).

## Develop

```bash
npm install
npm test          # transport unit + e2e (mock XGEN) — no live server needed
npm run typecheck # main/preload/core
npm run build     # electron-vite bundle
npm run dev       # run the app (needs a display)
```

## Package

Build installers locally (only your own OS can be fully built locally):

```bash
npm run dist:linux   # AppImage + deb
npm run dist:win     # nsis
npm run dist:mac     # dmg (macOS ad-hoc signed via build/afterPack.cjs)
```

### Cutting a release

Bump `version` in `package.json`, then push a matching `v*` tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The [`Release Installers`](.github/workflows/release.yml) workflow builds
macOS/Windows/Linux on GitHub runners, then publishes every installer plus the
`latest*.yml` update feeds to a **GitHub Release**. Those releases feed the
in-app auto-updater (`electron-updater`). macOS is ad-hoc signed and Windows is
unsigned (Developer ID + notarization land later).

## Using the transport core directly

The `core` package is a usable XGEN client on its own (Node ≥18 or a browser):

```ts
import { XgenClient } from 'xgen-connector/core';

const xgen = new XgenClient({ baseUrl: 'https://xgen.example.com' });
await xgen.login('me@corp.com', 'password');
const { items } = await xgen.agents.list();
for await (const ev of xgen.chat.stream({
  workflowId: items[0].workflowId,
  workflowName: items[0].workflowName,
  input: '안녕하세요',
  interactionId: 'conv-1',
})) {
  if (ev.kind === 'text') process.stdout.write(ev.content);
}
```

## Design

The UI follows the **XGEN design system** — the brand gradient (`#305eeb → #783ced`),
Pretendard typography, gray scale, chat bubbles and citation pills are copied 1:1
from `xgen-frontend` (`packages/ui/src/styles/globals.css`). The XGEN logo is the
official mark from `@xgen/icons`, re-authored as clean React SVGs in
[`src/renderer/src/brand/Logo.tsx`](src/renderer/src/brand/Logo.tsx). Light and dark
themes are both supported (Settings → 테마).

## License

Apache-2.0

Bundled font **Pretendard** (`src/renderer/src/assets/fonts/PretendardVariable.woff2`)
is © Kil Hyung-jin, licensed under the SIL Open Font License 1.1.
