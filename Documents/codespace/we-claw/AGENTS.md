# AGENTS.md

## Project Intent

This project builds a local-installable frontend interaction app powered by the OpenClaw agent runtime.

The target experience is similar to Cowork-style agent collaboration: a user-facing local UI for creating, steering, observing, and resuming agent work, while the agent kernel itself remains OpenClaw rather than a custom orchestration engine.

Primary goals:
- Provide a polished local frontend for interactive agent workflows.
- Use OpenClaw directly as the agent execution core.
- Keep the app installable and runnable on a developer machine without requiring hosted infrastructure.
- Preserve transparent agent state, logs, task history, and resumability.
- Avoid inventing a parallel agent runtime when OpenClaw already provides the needed primitives.

## Operating Principles

- Prefer direct integration with OpenClaw APIs, CLI, config, state, and lifecycle primitives over duplicating orchestration logic in the frontend.
- Treat the frontend as a control surface, not the source of truth for agent execution.
- Keep boundaries explicit: UI manages interaction, persistence, display, and local app ergonomics; OpenClaw manages agent planning, execution, tools, and runtime state.
- Verify OpenClaw behavior against official docs or local source before relying on assumptions.
- Build incrementally: first a narrow working vertical slice, then richer session management, multi-agent views, installation packaging, and polish.
- No new dependencies without a clear reason. Reuse existing framework utilities and local patterns once the stack is chosen.
- Keep diffs small, reviewable, and reversible.

## Product Shape

Expected user-facing capabilities:
- Create a new agent task from a local UI.
- View live agent progress, tool activity, logs, and final results.
- Pause, resume, cancel, or retry work where OpenClaw supports it.
- Browse previous local sessions.
- Inspect files or artifacts produced by the agent.
- Configure local OpenClaw connection/runtime settings.
- Run entirely on the user's machine.

Do not build a marketing landing page as the primary experience. The first screen should be the actual agent workspace.

## Architecture Guidance

Preferred shape:
- A frontend app for the interactive workspace.
- A thin local backend or bridge only if needed for filesystem access, process control, streaming logs, or OpenClaw integration.
- OpenClaw remains the execution engine.
- Local persistence should mirror or index OpenClaw state instead of replacing it.

Avoid:
- A custom agent planner.
- A separate task graph engine unless OpenClaw cannot provide the required behavior.
- Hidden background behavior that the UI cannot explain or recover.
- Cloud-only assumptions.

Before implementing integration-heavy code:
- Inspect the current OpenClaw integration surface available to this project.
- Confirm whether OpenClaw should be invoked through SDK, CLI, subprocess, local server, or embedded runtime.
- Document the chosen boundary in code comments or project docs when it affects future extension.

## Frontend Standards

- Build the actual workspace UI, not a landing page.
- Current design target is desktop-first and desktop-only for this phase; do not spend product or QA effort optimizing mobile/narrow layouts unless the project explicitly reopens mobile support.
- Prioritize dense, usable operational interfaces over decorative layouts.
- Make agent status, current action, pending user input, logs, and artifacts easy to scan.
- Use familiar controls: icon buttons for tools, tabs for views, toggles for binary settings, menus for option sets, and clear primary actions.
- Do not place cards inside cards.
- Keep cards for repeated items, modals, and genuinely framed tools.
- Ensure text never overlaps or overflows its parent at common desktop widths.
- Use stable dimensions for toolbars, sidebars, log panes, task rows, and status indicators so streaming updates do not shift layout unnecessarily.
- Prefer existing icon libraries if the chosen stack includes one.

## Local Installation

The project should eventually support a clear local install/run path.

Implementation should keep these concerns visible:
- Required OpenClaw version or executable path.
- Local configuration location.
- Session/state storage location.
- Runtime logs location.
- Upgrade and migration behavior for persisted local data.

Do not hardcode machine-specific paths unless they are explicitly development-only and documented.

## Verification

Before claiming implementation complete:
- Run the relevant lint, typecheck, tests, and build commands for the chosen stack.
- For frontend changes, run the app locally and inspect the UI in a browser.
- For OpenClaw integration changes, verify a real or mocked agent task lifecycle end to end.
- Report any verification gaps clearly.

For visual work:
- Check at least one representative desktop viewport. Mobile/narrow viewport QA is out of scope for the current phase unless explicitly requested.
- Confirm streaming/progress states do not break layout.

## Coding Conventions

- Use TypeScript for application code unless the project later chooses a different stack deliberately.
- Prefer structured parsers and APIs over ad hoc string manipulation.
- Keep integration code isolated behind clear adapter boundaries.
- Keep UI components focused on presentation and interaction; do not bury process orchestration inside components.
- Add comments only when they explain non-obvious runtime or integration constraints.
- Use ASCII by default unless existing files or product copy require otherwise.

## Git And Change Discipline

- Do not revert user changes unless explicitly requested.
- Do not run destructive git commands.
- Keep unrelated refactors out of feature diffs.
- If commits are requested, use the Lore Commit Protocol already defined by the workspace-level instructions.

## Open Questions To Resolve During Implementation

- Which OpenClaw interface is the stable integration target: SDK, CLI, local server, or embedded runtime?
- What session state does OpenClaw own, and what should the app index separately?
- How should user approvals, prompts, and interruptions flow between UI and OpenClaw?
- What packaging target should come first: local web app, desktop app, or installable CLI-launched UI?
- What authentication or credential model is required for local OpenClaw execution?
