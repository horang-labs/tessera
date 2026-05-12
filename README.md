# Tessera

> Organize AI coding sessions across projects, collections, tabs, panes, tasks, and Git worktrees.

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/@horang-labs/tessera?label=npm)](https://www.npmjs.com/package/@horang-labs/tessera)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](#license)

Tessera keeps Claude Code, Codex, and OpenCode sessions organized across projects, collections, tabs, panes, tasks, and Git worktrees. Run agents side by side, inspect tool logs and diffs, and move implementation work from chat to pull request without losing context.

<table>
  <tr>
    <td width="50%"><img src="https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/list-view.png" alt="Tessera list view"></td>
    <td width="50%"><img src="https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/kanban-board.png" alt="Tessera Kanban board"></td>
  </tr>
</table>

Projects + collections | Tabs + panes | Claude Code + Codex + OpenCode | Kanban board | Git worktrees | Tool logs + diffs + PRs | Windows (including WSL) + macOS + browser + linux(beta)

| Link | Purpose |
|------|---------|
| [Download Latest Release](https://github.com/horang-labs/tessera/releases) | Get the Windows or macOS desktop beta |
| [npm package](https://www.npmjs.com/package/@horang-labs/tessera) | Install the browser runtime |
| [Product Hunt launch][product-hunt] | Support Tessera on Product Hunt |
| [Team design partner waitlist][design-partner-waitlist] | Help shape team workspaces, permissions, and enterprise adoption |
| [GitHub Issues](https://github.com/horang-labs/tessera/issues) | Report bugs, rough edges, and feature ideas |
| [Good first issues][good-first-issues] | Pick up starter-sized docs, QA, and polish work when available |
| [Help wanted][help-wanted] | Find community-friendly areas where maintainer context is useful |
| [Discussions][discussions] | Ask questions, propose workflows, and shape larger ideas |
| [Contributing][contributing] | Set up the project and send focused pull requests |

## Product Demos

### Projects, collections, sessions, tabs, and panes

Organize AI coding work by project and collection, then open sessions across persistent tabs and split panes.

![Drag-and-drop multi-panel workspace](https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/dnd-multipanel.gif)

### Terminal and file tabs

Open agent sessions, terminals, and files as movable tabs so you can reshape the workspace around the work instead of switching tools.

![Terminal and file tabs](https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/terminal-agent-tabs.png)

### Kanban board workflow

Move implementation work through Todo, Doing, Review, and Done while keeping each task tied to sessions, collections, and worktrees.

![Kanban board drag-and-drop workflow](https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/kanban-board-dnd.gif)

### Realtime Git worktree tracking

Track each task's worktree, branch, diff, PR state, and workflow status as agents continue working.

![Git workflow status in list view](https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/git-workflow-list-view.gif)

### Rich composer controls

Open new panels, continue an existing conversation, tune reasoning, select models, choose permissions, use voice input (browser runtime only), add `@` references, attach images, and send context-rich prompts from one composer.

![Composer controls and rich context input](https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/composer-controls.gif)

### Cross-platform agent workspace

Use the same multi-agent workspace in the browser, on macOS, or on Windows while running Claude Code, Codex, OpenCode, and their model choices side by side.

![Cross-platform agent workspace](https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/multi-model-workspace.gif)

### Agent state, tool logs, and diffs

Keep each agent session tied to its task and worktree while tracking tool calls, failures, file changes, diffs, and branch state in real time.

![Agent state, tool logs, and diffs](https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/agent-panel.png)

### Custom worktree paths

Choose where Tessera creates managed worktrees so agent tasks fit into your existing local development workflow.

![Custom worktree path settings](https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/worktree-path.png)

## Install

Choose the runtime that fits your setup:

| Runtime | How to run |
|---------|------------|
| Windows desktop | Download the portable `.exe` from [GitHub Releases](https://github.com/horang-labs/tessera/releases) |
| macOS desktop | Download the `.dmg` from [GitHub Releases](https://github.com/horang-labs/tessera/releases) |
| Browser | Install the npm CLI and open the printed local URL |
| Docker Compose | Build and run the local browser runtime in a container |

macOS release DMGs are Developer ID signed and notarized. Windows portable `.exe` builds are not code-signed yet, so Windows SmartScreen may show an unknown-publisher warning. See [Desktop Releases](#desktop-releases).

For the browser runtime:

```bash
npm install -g @horang-labs/tessera
tessera
```

Tessera prints the local browser URL after startup:

```text
Tessera is running at:
  http://127.0.0.1:32123

Press Ctrl+C to stop.
```

The default port is `32123`. If that port is already in use, Tessera scans upward and prints the actual URL it selected.

To request a specific port:

```bash
tessera --port 3100
```

For Docker Compose:

```bash
mkdir -p data/config data/local data/ssh data/codex data/tessera workspaces
touch data/gitconfig
docker compose up --build -d
```

Create the mounted `./data/` and `./workspaces/` paths before starting the container so Docker does not create them as root-owned paths. The image runs Tessera as the `tessera` user with UID/GID `1000`, so the bind-mounted paths must be writable by that user. On most Linux developer machines, creating the paths with your normal user is enough. If your host UID/GID differs from `1000:1000`, or Docker already created root-owned paths, fix ownership before starting:

```bash
sudo chown -R 1000:1000 data workspaces
```

Open `http://127.0.0.1:32123` after the container starts. The Compose setup builds the image from the local `Dockerfile`, exposes Tessera on port `32123`, stores app and CLI state under `./data/`, and mounts local workspaces under `./workspaces/`.

Useful Compose commands:

```bash
docker compose logs -f tessera
docker compose down
```

## Core Features

Tessera is designed for developers who run multiple AI coding sessions and need more structure than terminal tabs:

| Feature | Details |
|---------|---------|
| Session organization | Structure AI coding work by project, collection, chat session, task, tab, pane, and worktree |
| Parallel workspace | Run many chats and implementation tasks side by side without losing status, context, or ownership |
| Multi-panel UI | Persistent tabs, split panes, draggable sessions, and long-running workspace layouts |
| Chat-to-task flow | Start with research or ideation, then continue the conversation into a managed git worktree |
| Observable session timeline | Agent output, reasoning, tool calls, failed tool context, permissions, plans, user prompts, files, diffs, branches, and PR state in one place |
| List and Kanban views | Use list view for high-volume exploration and Kanban view when implementation status matters |
| Git and PR workflow | Commit, push, create PRs, merge PRs, inspect diffs, and track branch/PR state from the Git panel |
| Context-rich composer | `@` file references, chat/task references, pasted images, and local file attachments |
| Drag-and-drop workspace | Move sessions, arrange workspace structure, and attach context through drag-and-drop interactions |
| Provider-native controls | Permission prompts, plan approvals, runtime modes, reasoning controls, and provider access controls in the workspace |
| Model choice through OpenCode | Use the models and providers configured in OpenCode, including local or air-gapped LLM setups |
| Cross-environment support | macOS, Windows, and browser-based npm runtime |
| Unified session history | Session history, multi-agent conversation data, attachments, settings, worktree metadata, and workspace state in one place |

Also included: keyboard-first navigation, browser-native voice input through the Web Speech API in the browser runtime, and a Claude Code skills dashboard discovered from the local environment.

## Technical Highlights

Tessera is built around a local runtime and provider-based CLI layer:

- **Provider adapter architecture**: each CLI is isolated behind a `CliProvider` contract for process lifecycle, protocol parsing, runtime controls, approvals, interrupts, and skills.
- **Protocol normalization layer**: Claude Code `stream-json`, Codex `app-server`, and OpenCode ACP JSON-RPC events are translated into a shared realtime message model.
- **Agent workspace model**: chats, tasks, collections, workflow states, managed git worktrees, PR state, diffs, provider controls, and interactive prompts are modeled as first-class workspace concepts.
- **OpenCode model bridge**: Tessera reads OpenCode's model catalog and exposes configured models, providers, and reasoning variants in the workspace.
- **Shared local runtime**: desktop and browser runtimes share the same local server, provider layer, and configurable app-data directory.

## First Run

On first run, Tessera opens a setup flow.

1. If you are using the npm browser runtime, create the first local account. No default password is created. The desktop app does not require this step.
2. Confirm that at least one supported provider CLI is installed and authenticated.
3. Add or select a project folder.
4. Start a chat for exploration or create a task for worktree-backed implementation.

For provider login, use the provider's own CLI first, for example `claude login`, `codex login`, or OpenCode's configured provider credentials.

## Supported CLIs

| Provider | Local command | Status | Notes |
|----------|---------------|--------|-------|
| Claude Code | `claude` | Supported | Uses streaming JSON mode, permission modes, plan approval, `AskUserQuestion` prompts, and installed skill discovery |
| Codex | `codex` | Supported | Uses `app-server` JSON-RPC events, approval requests, plan deltas, sandbox/access controls, and reasoning effort |
| OpenCode | `opencode` | Supported | Uses ACP JSON-RPC, OpenCode modes, permission presets, and the models/providers configured in OpenCode |

Provider-specific implementation lives under `src/lib/cli/providers/`. The rest of the app talks to the shared provider contract instead of CLI-specific internals.

## Requirements

- Node.js 20 or later
- npm 10 or later
- At least one supported CLI installed and authenticated:
  - [Claude Code CLI](https://code.claude.com/docs/en/overview)
  - [Codex CLI](https://developers.openai.com/codex/cli)
  - [OpenCode CLI](https://opencode.ai/docs/)

You can check your local tools with:

```bash
node -v
npm -v
claude --version
codex --version
opencode --version
```

## Build From Source

For development, clone the repository and install dependencies:

```bash
git clone https://github.com/horang-labs/tessera.git
cd tessera
npm install
```

Tessera uses a custom Node.js server for the Next.js app, WebSocket transport, database initialization, provider bootstrapping, and background pollers. Run `server.ts` instead of starting Next.js directly:

```bash
npm run dev
```

The development server uses port `3100` by default. To run on a different port, set `PORT`, for example `PORT=32124 npm run dev`.

Supported environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `TESSERA_DATA_DIR` | `~/.tessera` | App data root for the database, local users, auth keys, settings, worktrees, attachments, and session history |
| `PORT` | `3000` from source, `32123` from the npm CLI | HTTP server port for source and npm runs |
| `TESSERA_HOST` | `127.0.0.1` | Host interface for source and npm runs. `HOST` is also accepted by the source server |
| `LOG_LEVEL` | `info` | Backend log level: `debug`, `info`, `warn`, or `error` |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Override the Claude Code config directory used for skill discovery |

Desktop release builds use Electron:

| Target | Command |
|--------|---------|
| Windows portable `.exe` | `npm run electron:build:win` |
| macOS Apple Silicon dev `.dmg` | `npm run electron:build:mac-arm64` |

Electron build outputs are written under `release/`.

## Stored Data And Privacy

Tessera runs locally and stores app data under `~/.tessera/` by default.

Tessera includes anonymous telemetry in published npm and desktop builds to measure minimal usage. Telemetry is collected with PostHog and stored in the US region.

Tessera does not collect sensitive data such as IP addresses, prompts, messages, file paths, command output, repository names, or account details. You can disable telemetry during onboarding or later in Settings. Local source development runs do not send telemetry unless `TESSERA_TELEMETRY_LOCAL=1` is set.

Common default paths:

| Path | Purpose |
|------|---------|
| `~/.tessera/tessera.db` | SQLite app database |
| `~/.tessera/users.json` | Local user account records |
| `~/.tessera/auth/` | Auto-generated RSA keys for login sessions |
| `~/.tessera/settings/` | User settings |
| `~/.tessera/worktrees/` | Managed temporary git worktrees, when used |
| `~/.tessera/attachments/` | Local attachment files, when used |
| `~/.tessera/session-history/` | Session event history, when used |
| `~/.tessera/session-exports/` | Exported session files, when used |

Back up the data directory if you want to preserve Tessera's local state.

Provider requests are handled by the provider CLIs installed on your machine. Tessera does not replace the provider's authentication, billing, model access, or network behavior.

## Tech Stack

| Area | Stack |
|------|-------|
| App runtime | Next.js, React, TypeScript, custom Node.js server |
| UI | Tailwind CSS, Zustand, TanStack Virtual |
| Realtime | `ws` WebSocket transport |
| Local database | `sql.js` SQLite |
| Auth | `bcryptjs`, RS256 JWT cookies |
| Desktop shell | Electron |
| Packaging | npm global CLI, Electron builds via `electron-builder` |

## Desktop Releases

Desktop release assets are built by GitHub Actions for `v*` tags and attached to GitHub Releases:

- Windows portable `.exe` (not code-signed yet)
- macOS `.dmg` for Apple Silicon and Intel, Developer ID signed and notarized

macOS release DMGs are signed and notarized with Apple Developer ID, so downloaded releases should open normally on macOS.

Windows release builds are portable `.exe` files and are not code-signed yet. SmartScreen may show an unknown-publisher warning; choose **More info** and then **Run anyway** to start Tessera.

If Gatekeeper still blocks a macOS release DMG, please report it as a release-signing issue.

See [macOS Distribution](docs/MACOS_DISTRIBUTION.md) for local and CI setup.

## Teams And Design Partners

Tessera is currently focused on individual local workflows, but we are preparing team and enterprise features for companies running coding agents across multiple developers.

The team product is being shaped around three areas: shared workspaces for parallel agent work, governance for permissions and tool use, and operational visibility into agent usage, cost, and review state.

If your team wants to use Tessera in production, [join the design partner waitlist][design-partner-waitlist].

## Community And Contributions

Tessera is for developers who run coding agents every day. We welcome focused issues and pull requests from real usage: desktop QA on Windows, macOS, and Linux; Claude Code, Codex, and OpenCode provider edge cases; documentation fixes; UI polish; and workflow reliability improvements.

Start with [good first issues][good-first-issues] or [help wanted][help-wanted] when they are available. If your change is larger than a focused fix, open a [discussion][discussions] or issue first so we can align on the approach.

Thanks to [@jakedev796](https://github.com/jakedev796), Tessera's first external contributor, for helping exercise real Windows and Electron workflows and landing practical fixes in v0.1.4.

## Roadmap

Planned areas include:

| Area | Direction |
|------|-----------|
| Cloud team collaboration | Shared projects, team-visible task state, and collaborative review workflows |
| Enterprise governance | Permission management, tool-use policies, audit trails, and controls for blocked or unapproved agent actions |
| Agent operations analytics | Visibility into agent efficiency, model/provider usage, and cost patterns across a team workspace |
| Team memory | Shared project context and team-specific agent memory for recurring workflows |
| Multi-agent collaboration | A lead agent that coordinates task creation, review, Git workflow management, and parallel worker agents |
| Tessera-native agent | A built-in agent experience in addition to external CLI providers |
| Web debugging | Browser inspection, logs, screenshots, and frontend debugging context |

## Troubleshooting

**`claude`, `codex`, or `opencode` is not found**

Install the CLI you want to use, authenticate it, and make sure the command works in the same terminal where you run `tessera`.

**Provider status says `needs_login`**

Run the provider's login or setup command, then refresh Tessera's provider status.

**Reset local login keys**

If login tokens become invalid after moving files between machines, stop Tessera and remove the generated auth keys:

```bash
rm -rf ~/.tessera/auth
tessera
```

If you start Tessera with `TESSERA_DATA_DIR`, remove the `auth/` directory under that custom data directory instead.

## License

Tessera is open source under the Apache License 2.0 (`Apache-2.0`).

Copyright (c) 2026 Horang Labs, Inc.

See the [LICENSE](LICENSE) file for the full text.

Claude Code is a trademark of Anthropic. Codex and OpenAI are trademarks of OpenAI. Tessera is not affiliated with or endorsed by Anthropic or OpenAI.

[design-partner-waitlist]: https://docs.google.com/forms/d/e/1FAIpQLSdbo5haZdekBrQNwt_F-UlloQu-s4SkUV4tZCU0cONwKJX8Tw/viewform
[product-hunt]: https://www.producthunt.com/posts/tessera-6
[contributing]: CONTRIBUTING.md
[good-first-issues]: https://github.com/horang-labs/tessera/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22
[help-wanted]: https://github.com/horang-labs/tessera/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22
[discussions]: https://github.com/horang-labs/tessera/discussions
