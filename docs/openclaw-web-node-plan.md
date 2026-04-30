# We-Claw OpenClaw Web + Node Plan

## Status

Draft for discussion.

This plan targets a pure Web + thin Node local installation path. The immediate product goal is a focused chat workspace whose agent kernel is OpenClaw, not a custom runtime.

## Decision Summary

Use OpenClaw Gateway as the runtime boundary, with We-Claw managing or discovering a local loopback Gateway process.

We-Claw should be a local web app plus a thin Node launcher. The frontend connects to OpenClaw Gateway over its existing WebSocket RPC protocol. Node is responsible for serving the We-Claw web assets, detecting OpenClaw, starting or discovering the local Gateway, and exposing safe bootstrap/health information. Node should not become a parallel OpenClaw runtime or a broad Gateway RPC proxy unless a concrete browser auth or transport constraint requires it.

Implementation stack decision: the production app should use Vite + TypeScript. The current root `index.html`, `styles.css`, and `app.js` are visual interaction references, not the long-term app architecture.

```text
Browser UI
  -> We-Claw Node launcher / local server
  -> OpenClaw Gateway WebSocket

OpenClaw Gateway
  -> OpenClaw agents, sessions, tools, approvals, logs
```

The frontend should not reimplement agent orchestration. It should present and steer OpenClaw sessions through Gateway APIs such as `chat.send`, `chat.history`, `chat.abort`, `sessions.list`, and Gateway event streams.

WeChat is useful as architecture evidence, not as a We-Claw dependency. OpenClaw talks to WeChat through the external `@tencent-weixin/openclaw-weixin` channel plugin. That plugin owns QR login, Tencent iLink communication, media handling, account monitoring, inbound normalization, and outbound delivery. We-Claw's first product slice does not integrate with that plugin directly; it uses the same Gateway/WebChat control surface that OpenClaw already exposes for local chat UI.

## Evidence From OpenClaw

- OpenClaw already ships a CLI entrypoint through `openclaw.mjs` and requires Node.js 22.12+.
- OpenClaw already has a Gateway-backed Control UI opened by `openclaw dashboard`.
- OpenClaw's browser UI uses a WebSocket client with request frames shaped as `{ type: "req", id, method, params }`.
- Gateway exposes chat methods: `chat.history`, `chat.abort`, `chat.send`.
- Gateway exposes session methods: `sessions.list`, `sessions.create`, `sessions.send`, `sessions.abort`, session subscribe methods, and compaction operations.
- Gateway emits events including `chat`, `agent`, `session.message`, `session.tool`, `sessions.changed`, and approval events.
- Gateway method access is scope-based, so We-Claw should use the existing auth and scope model rather than bypassing it.
- OpenClaw WebChat uses Gateway WebSocket directly and treats Gateway transcript/history as the source of truth.
- WeChat support is external plugin behavior; it should not shape We-Claw's first implementation beyond validating that channel integrations belong behind OpenClaw's plugin contract.
- ACP exists, but OpenClaw documents it as an ACP bridge for IDE/client integrations, not as the best primary surface for a rich browser workspace.

## Architecture

### Frontend

Responsibilities:
- Render the main agent workspace.
- Connect to Gateway via WebSocket.
- Display sessions, active run state, streamed assistant output, and minimal errors in v1.
- Add tool activity, logs, approvals, and artifacts only after the chat/session loop is working.
- Send user prompts and steering messages.
- Issue abort/cancel requests.
- Persist UI preferences locally.

Non-responsibilities:
- Agent planning.
- Tool execution.
- Runtime state ownership.
- Long-term session truth.
- WeChat/iLink communication.
- OpenClaw plugin or channel orchestration.

### Node Launcher / Local Server

Responsibilities:
- Serve the We-Claw static app.
- Detect whether `openclaw` is installed and usable.
- Check Node version and OpenClaw version.
- Start and supervise `openclaw gateway` when no compatible Gateway is already running.
- Resolve local Gateway URL and auth readiness safely.
- Provide a small local API for app bootstrapping, health checks, and launcher state.
- Avoid leaking Gateway tokens into URLs, logs, or browser history.
- Track Gateway process ownership so We-Claw only stops processes it started.

The Node layer should stay thin. It should not proxy every Gateway request unless browser auth, CORS, TLS, or token handling makes direct browser-to-Gateway connection unsafe in implementation.

Network exposure decision for v1: We-Claw only supports loopback Gateway access. Managed Gateway must bind to a local-only address such as `127.0.0.1`; LAN, public, Tailscale, and remote Gateway access are out of scope for the first implementation.

### OpenClaw Gateway

Responsibilities:
- Agent execution.
- Session storage and transcript state.
- Tool calls and tool events.
- Approvals.
- Model/provider configuration.
- Runtime logs.
- Auth and operator scopes.

## Recommended First Vertical Slice

Build the smallest usable local workspace:

1. `we-claw` Node entrypoint
   - Start a local HTTP server for the UI.
   - Detect `openclaw --version` or equivalent availability.
   - Probe for a compatible loopback OpenClaw Gateway before starting a new one.
   - Start `openclaw gateway` in loopback mode on the OpenClaw default Gateway port, usually `18789`, only when needed.
   - Wait until the Gateway is reachable.
   - Expose `/api/bootstrap` with Gateway URL, ownership state, process state, and safe auth/readiness hints.

2. Gateway WebSocket client
   - Implement protocol-compatible connect/auth handshake.
   - Support generic `request(method, params)`.
   - Subscribe to Gateway events.
   - Handle reconnect and sequence gaps conservatively.

3. Chat workspace
   - Load `chat.history`.
   - Send prompts through `chat.send`.
   - Stream `chat` events into the UI.
   - Abort active runs through `chat.abort`.

4. Session rail
   - Load `sessions.list`.
   - React to `sessions.changed`.
   - Switch active session.
   - Create/reset session if supported by the Gateway method set.
   - Keep the rail focused on Gateway sessions: no project tree, plugin list, automation list, or duplicate chat list in the default first screen.

5. Minimal run feedback
   - Render `chat` final/error states and a compact running state.
   - Treat rich tool rows, approval cards, artifact previews, logs, and raw payload inspection as follow-up capabilities after chat and sessions work end to end.

## Product Milestones

### Milestone 0: Chat And Session Probe

Goal: prove We-Claw can talk to a local OpenClaw Gateway and run the smallest useful chat/session loop.

Deliverables:
- Minimal Node launcher.
- Managed-or-discovered loopback Gateway startup.
- Minimal WebSocket RPC client.
- Compact workspace status showing Gateway connection state.
- Session rail backed by `sessions.list`.
- Chat transcript backed by `chat.history`.
- Prompt composer backed by `chat.send`.
- Manual test against installed OpenClaw.

Acceptance criteria:
- The app detects missing OpenClaw and reports an actionable error.
- The app connects to an existing compatible loopback Gateway or starts one when needed.
- The app can call `health`, `sessions.list`, `chat.history`, and `chat.send`.
- The user can switch between listed Gateway sessions.
- The app exits without killing any OpenClaw process it did not start.

### Milestone 1: Usable Chat Workspace

Goal: make the core chat and session workspace reliable enough for daily local use.

Deliverables:
- Chat transcript view.
- Prompt composer.
- Send/stop controls.
- Streaming assistant output.
- Error and disconnected states.
- Minimal session switching and active-session title.

Acceptance criteria:
- User can send a prompt to an OpenClaw session.
- Assistant response streams or updates without layout breakage.
- Stop button calls `chat.abort`.
- Reloading the page recovers transcript through `chat.history`.
- Switching sessions reloads the selected session's transcript from Gateway.

### Milestone 2: Session Workspace Polish

Goal: make the retained session rail useful without expanding into an admin dashboard.

Deliverables:
- Session list/sidebar.
- Session switching.
- Session status indicators.
- Basic search/filter if session count is large.
- Lightweight session create/reset controls where supported by Gateway.

Acceptance criteria:
- User can switch sessions without losing local UI state.
- Session list updates when Gateway emits session changes.
- Active runs are visible and distinguishable from completed sessions.
- The rail remains a session rail only; it does not become a project tree, plugin browser, or OpenClaw admin surface.

### Milestone 3: Local Install UX

Goal: make local startup predictable.

Deliverables:
- `we-claw` CLI command.
- `we-claw start` starts UI and discovers or manages a local OpenClaw Gateway.
- Clear config discovery.
- Logs for We-Claw launcher separate from OpenClaw logs.

Acceptance criteria:
- Fresh local user can run one documented command to open the app.
- Fresh local user gets a compatible loopback Gateway without running `openclaw gateway` manually.
- Failures explain whether the problem is We-Claw, OpenClaw install, Gateway auth, or model/provider setup.

### Milestone 4: Cowork-like Controls

Goal: add richer work steering and observability.

Deliverables:
- Queue/steer follow-up messages while a run is active.
- Inline approval cards; a separate approval inbox is optional only after the inline flow works.
- Tool output expansion.
- Artifact/file preview hooks where Gateway payloads expose paths or references.
- Agent/model selectors where supported.

Acceptance criteria:
- User can observe what the agent is doing without reading raw logs.
- User can interrupt or steer long-running work.
- Approval requests are visible and actionable.

## Interface Contract To Build Around

The We-Claw Gateway client should initially support only the methods needed for the chat/session loop:

- `connect`
- `health`
- `sessions.list`
- `chat.history`
- `chat.send`
- `chat.abort`

Optional v1 additions if Gateway capability probing confirms support and the UI needs them:

- `status`
- `sessions.create`
- `sessions.subscribe`
- `sessions.unsubscribe`

Important event types:

- `chat`
- `sessions.changed`
- `shutdown`
- `health`
- `tick`

Defer until after the chat/session loop:

- `agents.list`
- `sessions.abort`
- `sessions.messages.subscribe`
- `sessions.messages.unsubscribe`
- `logs.tail`
- `exec.approval.list`
- `exec.approval.resolve`
- `agent`
- `session.message`
- `session.tool`
- `exec.approval.requested`
- `exec.approval.resolved`

## Key Design Choices

### Conversation-First Workspace

Default choice: the conversation/workspace area is the primary interaction surface.

Current viewport target: desktop-only for this phase. We-Claw should optimize the local desktop browser workspace first and should not spend design, implementation, or QA effort on mobile/narrow layouts until mobile support is explicitly reopened.

Hard constraints:
- The first screen must be an actual working agent workspace, not a dashboard or landing page.
- Conversation must keep most of the viewport height.
- Topbar must stay compact and should not exceed 56px in the default desktop layout.
- Composer must stay compact by default, with a bounded expansion height for multi-line input.
- Gateway status, model selection, permissions, tool activity, and run state must not permanently expand the topbar or composer.
- V1 shows messages, running/final/error chat states, and minimal session state. Tool events, artifacts, approvals, logs, and rich payloads are follow-up inline stream blocks after the chat/session loop works.
- Any future side detail panel must be optional, collapsible, and not part of the default first-screen layout.
- The left rail is a Gateway session rail, not a project/file navigator or OpenClaw admin surface.
- The only persistent primary actions in the first screen are new session, session switching, message send/stop, and a compact overflow menu.
- Stable connected state belongs in the compact topbar status only; do not duplicate it as an inline conversation card.
- Model, permission, file, plugin, automation, and side-panel controls should be hidden until the Gateway reports support and the workflow actually needs them.

Preferred runtime status behavior:
- `Gateway starting`: show a lightweight inline status in the conversation area.
- `Connected`: show only a compact topbar status pill/dot.
- `Running`: switch send to stop and show a small topbar status dot.
- `Tool active`: deferred until tool-event rendering is implemented; do not design v1 around it.
- `Approval required`: deferred until approval RPCs are in scope; do not show mock approval cards in the working v1 UI.
- `Error`: show a recoverable inline error block, not a large persistent banner.

### Desktop Layout Contract

Default desktop layout:
- Left rail: app identity, Gateway status dot, new session action, Gateway session list, and local settings.
- Topbar: active session title, workspace/session subtitle, compact Gateway connection state, and one overflow menu.
- Conversation column: centered and bounded; owns messages, tool rows, media, artifacts, approvals, errors, and progress.
- Composer: fixed near the bottom of the conversation column with add-context, active agent/session hint, readiness state, and send/stop.
- Statusbar: low-emphasis local runtime/context details only.

Do not add:
- Mac/window chrome inside the web app.
- Persistent plugin, automation, file browser, project tree, or duplicate conversation sections in the default first screen.
- Hardcoded model labels or broad permission labels such as "full access" unless they are backed by Gateway capability/state.
- A second persistent Gateway-connected card when the topbar already shows connected state.

### Conversation Stream Rich Content

Default choice: the conversation stream starts as a chat transcript plus minimal run state. It can grow into a typed event surface after the Gateway chat/session loop is stable.

OpenClaw implications:
- `chat.history` and live message events can contain ordered `content[]` parts.
- Text parts should render as normal assistant/user copy.
- Non-text message parts can carry `type`, `mimeType`, `fileName`, and base64 `content`; the known mobile UI already treats non-text base64 parts as image attachments.
- Tool events can expose media indirectly through structured `details.media.mediaUrl/mediaUrls`, text `MEDIA:` directives, or legacy `details.path` when image content exists.
- Tool follow-along data is best-effort and may include raw I/O, text content, and file locations without fully structured terminal or diff-native payloads.

V1 rendering model:
- Render `message.text` from user and assistant transcript entries.
- Render active `chat` run state as a compact in-stream or composer-adjacent status.
- Render `error.notice` for recoverable Gateway, auth, history, send, and abort failures.
- Preserve unknown content safely by omitting or summarizing it; do not build a raw payload inspector in v1.

Deferred rendering model:
- `tool.call`: compact running/completed tool row with name, duration, status, and one-line summary.
- `tool.output.text`: collapsible text/code/log output.
- `media.image`: bounded image preview with filename/mime metadata and open/save actions when a safe local URL or base64 payload is available.
- `media.audio`: compact audio row with play control, duration when known, and filename/source metadata.
- `media.video`: poster-style preview row; do not autoplay.
- `artifact.file`: file/path card for generated or modified local artifacts.
- `artifact.diff`: compact diff summary with expand/open actions when structured diff data or file paths are available.
- `approval.request`: inline approval card with requested action, risk summary, and explicit approve/reject controls.
- `raw.payload`: collapsed JSON/debug block for unknown or unsupported payloads.

Visual hierarchy:
- Primary messages: user and assistant text are the dominant reading surface.
- Blocking actions: approval cards are deferred; when added, they should be more prominent than tool rows because they require user action, but remain inline rather than modal by default.
- Runtime/tool activity: deferred compact rows that summarize process state and expand only on demand.
- Artifacts/media/output: deferred compact cards with preview-first rendering and explicit open/expand actions.
- System/runtime notes: temporary inline notices only for starting, reconnecting, history recovery, auth-needed, or failure states. Stable connected state belongs in the topbar status pill only.
- Errors: inline recoverable blocks with retry/details actions; avoid large persistent banners.

Layout rules:
- Rich blocks, once implemented, appear inline at the point they occur in the stream; do not move them into a permanent right panel by default.
- Each rich block starts compact. Large images, logs, JSON, diffs, and multi-file artifacts are preview-first with explicit expand/open actions.
- The stream must preserve chronological order across text, tools, media, approvals, and artifacts.
- Consecutive tool lifecycle updates for the same tool call should update one row instead of appending noisy duplicates.
- Tool rows should use stable heights for running/completed/error states so streaming updates do not shift the page.
- Rich previews should fit inside the conversation column. Oversized content uses contained scrolling or an optional expanded overlay, not horizontal page overflow.
- Unknown MIME types render as file cards with metadata and raw payload access, never as broken embeds.

Safety and data handling:
- Treat media and raw payloads from Gateway/tool output as untrusted content.
- Prefer object URLs or Gateway-provided local media URLs over embedding large base64 strings directly in long-lived DOM nodes.
- Do not leak local file paths or auth-bearing URLs into browser history, route URLs, or logs.
- Do not autoplay audio/video.
- For local file paths, display the basename prominently and the full path only in secondary text or an expanded details area.
- For remote URLs, show origin/host metadata and open through an explicit action.

Desktop interaction:
- Single click selects or focuses a rich block.
- Double click or `Open` expands images, diffs, logs, or artifacts into an optional detail overlay/panel.
- Copy actions are scoped to visible text, path, or JSON payload; avoid copying hidden sensitive fields by default.
- A future optional detail panel may show expanded artifact/media inspection, but the default first-screen layout remains conversation-first.

### Workspace Artifacts

Default choice: artifacts are not part of the first working v1 chat/session loop. The visual prototype may keep artifact examples as future-state references, but production v1 should not depend on artifact rendering.

Artifact types:
- `artifact.file`: a generated, modified, or referenced local file.
- `artifact.diff`: a compact file-change summary.
- `artifact.bundle`: a grouped multi-file result.
- `media.image`: screenshot, image attachment, or generated image.
- `tool.output.text`: command output, logs, test output, or other text stream.

Deferred behavior:
- Show a compact summary card by default.
- Allow lightweight inline expansion for preview/details.
- Prefer `Open`, `Copy path`, and `Show raw payload` actions over embedding a full editor.
- Show at most a small bounded file list for multi-file results, then collapse the rest behind `+N more`.
- Large logs, large diffs, large JSON, and large media are preview-first and must not auto-expand.
- Full file trees, built-in code editing, persistent artifact inspector panels, and default giant diffs remain out of scope for the first artifact implementation.

Artifact card minimum fields:
- Type label.
- Display name or basename.
- Status such as created, updated, modified, failed, or generated.
- Source, when known: assistant, tool, Gateway event, or user attachment.
- Optional path/details in secondary text.

### Permission And Run Modes

Default choice: v1 uses Gateway scopes directly and keeps We-Claw permission UI minimal.

Do not use "Full Access" language in the UI. It implies We-Claw can bypass OpenClaw's security model, which is not true. We-Claw permission mode is an interaction policy; OpenClaw Gateway scopes and runtime policies remain the enforcement layer.

Future mode model:
- `Read Only`: read status, sessions, history, logs, and metadata; no chat send or mutating actions.
- `Ask First`: default mode. Allow normal chat interaction, but show inline approval cards for risky or mutating actions.
- `Trusted Local`: reserved for a later version. May request broader local privileges, but still respects Gateway scopes, approvals, and policy.

Gateway scope mapping:
- `Read Only`: `operator.read`.
- `Ask First`: `operator.read`, `operator.write`, and `operator.approvals`.
- `Trusted Local`: may additionally request `operator.admin` only when a concrete supported feature requires it.

V1 implementation guidance:
- Composer should not show broad permission labels such as `Full Access` / `完全访问权限`.
- V1 may show a compact connected/read-write readiness state, but it should avoid exposing mode switching until there are multiple verified modes.
- `Read Only`, `Ask First`, and `Trusted Local` may appear in design notes but should not be enabled until the concrete Gateway operations that need them are implemented and verified.
- Approval requests and approval-card rendering are deferred until approval RPCs are in the v1+ interface contract.

### Managed Gateway Startup

Default choice: We-Claw first discovers a compatible loopback Gateway. If none is available, it starts and owns a managed Gateway process for v1.

Startup behavior:
- Start We-Claw's local HTTP server first.
- Use OpenClaw's default Gateway port for v1, usually `18789`.
- Probe for a compatible loopback OpenClaw Gateway.
- Spawn `openclaw gateway` with loopback-only binding and the selected default port only when no compatible Gateway is running.
- Wait for Gateway readiness before presenting the workspace as connected.
- Mark a reused Gateway as `ownership: "external"` and a spawned child as `ownership: "managed"`.
- Stop only the managed child process on We-Claw shutdown.

If a Gateway port is already occupied:
- Probe whether it is a compatible OpenClaw Gateway.
- If compatible, connect in `ownership: "external"` mode for v1 rather than killing or replacing it.
- If incompatible, report the port conflict clearly; do not auto-kill the process.
- Do not kill the existing process automatically.

Default port note:
- OpenClaw docs describe the Gateway WebSocket port as config/env driven and usually `18789`.
- We-Claw v1 should use `18789` unless a later config surface explicitly overrides it.
- A future version may support per-workspace managed Gateway ports, but that is out of scope for the first implementation.

Loopback-only note:
- We-Claw v1 should connect only to `127.0.0.1`, `localhost`, or equivalent loopback hosts.
- Remote Gateway URLs, LAN binding, Tailscale/public access, and TLS exposure are explicitly deferred.
- If OpenClaw config points to a non-loopback Gateway, v1 should report that it is unsupported by We-Claw's local-only mode instead of silently connecting.

### OpenClaw Configuration Surface

Default choice: v1 exposes only the minimum OpenClaw configuration needed to start, diagnose, and recover the local Gateway connection.

V1 should expose:
- OpenClaw executable discovery state and the resolved executable path.
- OpenClaw version and Node runtime compatibility status.
- Gateway ownership state: `managed`, `external`, or unavailable.
- Gateway host/port as local runtime status. The default Gateway port remains `18789` for v1 and should be treated as a launcher/runtime detail, not a general user-editable workspace setting.
- Loopback compatibility checks and clear errors when a configured or discovered Gateway is non-loopback.
- Auth/setup diagnostics that explain whether failure is caused by missing OpenClaw, Gateway startup, Gateway auth, model/provider setup, or port conflict.
- Launcher logs separate from OpenClaw logs, with secrets redacted.

V1 should not expose:
- A full OpenClaw configuration editor.
- Model/provider credential editing.
- Remote Gateway URLs, LAN binding, Tailscale/public access, or TLS exposure.
- Per-workspace Gateway port management.
- Admin/operator scope editing or permission-mode management.
- Plugin, automation, cron, device, or Control UI administration surfaces.

Rationale:
- Keeps the first implementation focused on the local agent workspace and Gateway lifecycle.
- Avoids duplicating OpenClaw's broader configuration/admin surface before the core chat/session flow is validated.
- Reduces the risk of leaking credentials or implying that We-Claw owns OpenClaw runtime policy.

### Browser-To-Gateway vs Node Proxy

Default choice: browser connects to OpenClaw Gateway WebSocket directly when local loopback auth and browser origin policy allow it. We-Claw Node remains a launcher/bootstrap server, not a broad RPC proxy.

Authentication boundary:
- Browser should use OpenClaw's existing Gateway auth/device flow where feasible.
- Browser must not receive, store, log, or persist long-lived Gateway tokens through route URLs, localStorage, or console logs.
- We-Claw Node exposes only safe bootstrap state by default: Gateway URL, ownership, reachability, supported local mode, and auth/setup diagnostics.
- `/api/bootstrap` may report auth/setup state and safe capability hints, but must not expose raw Gateway tokens or auth material.

Fallback proxy behavior:
- Add a We-Claw-owned Gateway proxy only if direct browser-to-Gateway connection fails a concrete security or transport requirement.
- If added, the proxy must be allowlisted to the v1 method/event contract instead of forwarding arbitrary Gateway traffic.
- If added, the proxy must map responses by request id, redact sensitive auth material, and report runtime status to the browser.
- If added, the proxy remains a transport/auth adapter only; it must not own sessions, transcripts, agent runs, or tool execution.

Rationale:
- Matches OpenClaw WebChat's direct Gateway WebSocket architecture.
- Keeps the Node layer thin and avoids reimplementing Gateway behavior.
- Reduces moving parts for the first chat/session loop.
- Keeps token handling explicit instead of hiding a second control plane inside We-Claw.

Do not:
- Put Gateway token in `/api/bootstrap`.
- Put Gateway token in route URLs, query strings, localStorage, or logs.
- Put We-Claw local session secrets in route URLs, query strings, localStorage, or logs if a proxy/session layer is later added.
- Let the browser or proxy call arbitrary Gateway methods beyond the active allowlist.
- Treat We-Claw permission mode as a replacement for Gateway scopes.

### Reuse OpenClaw UI Code vs Rebuild

Default choice: rebuild the product UI, reuse OpenClaw UI as protocol and behavior reference.

Reason:
- OpenClaw Control UI is broad and admin-oriented.
- We-Claw should be a focused agent workspace.
- Copying large Control UI surfaces would pull in channel/cron/device/config complexity before the core experience is validated.

Candidate reusable ideas:
- Gateway client protocol shape.
- Chat event handling.
- Tool stream display model.
- Session row normalization.
- Auth/device identity handling.

### Frontend Implementation Stack

Default choice: Vite + TypeScript.

The current static files are the visual source of truth for the first screen. Implementation should preserve the same conversation-first layout and interaction proportions while moving the production code into a typed app structure.

Initial app shape:
- Vite for local development/build.
- TypeScript for app, Gateway adapter, state reducers, and launcher API types.
- No framework dependency beyond what is needed for the first slice unless implementation evidence shows plain TypeScript is becoming brittle.
- Keep the visual prototype available as a reference until the Vite app matches it.

Scaffold decision:
- Use one package, not a workspace/monorepo.
- Use a single Node server as the local installation entrypoint.
- The Node server serves the built Vite frontend and all We-Claw `/api/*` routes.
- The managed OpenClaw Gateway remains a separate loopback process, usually on `127.0.0.1:18789`.
- Avoid a production architecture where the frontend dev server and Node API server are separate user-facing processes.

Target runtime shape:

```text
http://127.0.0.1:<we-claw-port>
  -> built Vite UI
  -> /api/bootstrap, /api/gateway/status, ...

ws://127.0.0.1:18789
  -> OpenClaw Gateway
```

Development can still use Vite middleware or a dev-only proxy internally, but the product shape is one We-Claw Node server serving both UI and local API.

### Gateway As Source Of Truth

Session history, run state, tools, approvals, and logs belong to OpenClaw.

We-Claw may cache for UX, but cache must be disposable and reloadable from Gateway.

## Risks And Mitigations

### Gateway Protocol Stability

Risk: Gateway WebSocket methods are proven by OpenClaw UI but may not be documented as a third-party stable API.

Mitigation:
- Keep all Gateway calls behind a typed adapter.
- Version-check Gateway features from `hello.features.methods`.
- Fail gracefully when methods are missing.
- Track OpenClaw version in bootstrap state.

### Auth And Token Handling

Risk: leaking tokens through URLs, console logs, browser history, or static config.

Mitigation:
- Prefer token files or device-token flow where possible.
- Keep auth in memory or secure local storage only when necessary.
- Never put tokens in route URLs.
- Separate launcher logs from secrets.

### Process Lifecycle

Risk: Node launcher starts duplicate gateways or leaves orphan processes.

Mitigation:
- Probe before start when using a fixed or configured port.
- Track child process PID only for processes started by We-Claw.
- Do not kill existing user-managed OpenClaw processes by default.
- Provide explicit stop/restart actions only for We-Claw-owned processes.
- Enforce loopback-only Gateway binding for v1.

### Overbuilding The Control Surface

Risk: copying the whole OpenClaw Control UI delays the core Cowork-like experience.

Mitigation:
- Ship the first slice around chat, session rail, session switching, and minimal run state.
- Add admin/config surfaces only when required by the workspace flow.

## Verification Plan

### Unit Tests

- Gateway frame parsing.
- Reconnect behavior.
- Method availability handling.
- Session row normalization.
- Chat event reducer.
- Launcher config resolution.

### Integration Tests

- Mock Gateway WebSocket server.
- `health` and `sessions.list` bootstrap.
- `chat.send` -> `chat` events -> final transcript.
- `chat.abort` active run.
- Auth failure states.

### Manual E2E

- Run against installed `/opt/homebrew/lib/node_modules/openclaw`.
- Start We-Claw with no Gateway running.
- Start We-Claw with Gateway already running.
- Send a real prompt.
- Abort a real active run.
- Reload and recover history.
- Switch between at least two Gateway sessions and verify each reloads from `chat.history`.
- Visually inspect the desktop workspace at a representative desktop viewport; mobile/narrow viewport checks are intentionally out of scope for the current phase.

## Open Questions

- Should the first UI be browser-only, or should we later wrap it with a desktop shell?
- What exact Cowork-like interaction is highest priority after the first slice: multi-agent panes, task board, richer artifact inspection, or inline approval flow?

## Next Discussion Points

Resolved:
- First supported transport path for local development: browser connects directly to OpenClaw Gateway WebSocket when loopback auth and origin policy allow it; We-Claw Node exposes safe bootstrap/health state and only adds a proxy if direct connection fails a concrete security or transport requirement.
- OpenClaw configuration exposed in We-Claw v1: only the minimum local startup, health, ownership, version, loopback, auth/setup diagnostics, and redacted launcher-log surface; no full OpenClaw config editor, model/provider credential editor, remote Gateway configuration, or admin/control surfaces.

Remaining:
1. Decide the first post-chat rich interaction: inline approval flow, richer artifact inspection, or multi-agent/task view.
