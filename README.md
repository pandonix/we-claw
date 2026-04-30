# We-Claw

We-Claw is a local Web + Node control surface for OpenClaw Gateway. The browser UI stays focused on sessions, transcript, send/stop controls, and launcher diagnostics; OpenClaw remains the agent runtime.

## Run Locally

```bash
npm install
npm run dev
```

The dev server exposes `/api/bootstrap`, checks the local `openclaw` executable, reports loopback Gateway state for the UI, and serves a local-only `/api/gateway/ws` WebSocket bridge.

For a production-style run:

```bash
npm run build
npm run start
```

By default the Node launcher serves the built UI on `127.0.0.1:4173` and checks OpenClaw Gateway on `127.0.0.1:18789`.

The project also includes local lifecycle scripts:

```bash
./start.sh
./stop.sh
```

`start.sh` builds the app, starts the local We-Claw server in the background, and writes pid/log files under `.runtime/dev`. `stop.sh` stops that recorded We-Claw process without stopping an unrelated OpenClaw Gateway listener.

The browser connects to We-Claw's bridge instead of directly connecting to OpenClaw Gateway. The bridge reads `OPENCLAW_GATEWAY_TOKEN` or local OpenClaw config on the Node side, signs the handshake with the local OpenClaw device identity, and does not return the token in `/api/bootstrap`.

## Configuration

- `WE_CLAW_OPENCLAW_BIN`: OpenClaw executable path. Defaults to `openclaw`.
- `WE_CLAW_GATEWAY_PORT`: OpenClaw Gateway port. Defaults to `18789`.
- `WE_CLAW_HTTP_PORT`: We-Claw local HTTP port. Defaults to `4173`.
- `WE_CLAW_MANAGE_GATEWAY=0`: Disable managed Gateway startup in the production launcher.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Manual browser QA should verify the desktop workspace at a representative wide viewport, especially the session rail, topbar status, inline Gateway diagnostics, conversation column, and fixed composer.
