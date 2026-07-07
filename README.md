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
- **Avatar extension point** — `setAvatarRenderer()` mounts a future avatar
  bound to the active agent + its streamed text. No avatar ships today.

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

```bash
npm run dist:linux   # AppImage + deb
npm run dist:win     # nsis
npm run dist:mac     # dmg (unsigned)
```

Releases publish to GitHub Releases (`PlateerLab/xgen-connector`), which feeds
the in-app auto-updater.

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

## License

Apache-2.0
