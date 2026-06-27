# Tessera

> Keep parallel AI coding work organized.

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/@horang-labs/tessera?label=npm)](https://www.npmjs.com/package/@horang-labs/tessera)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](#license)

Tessera helps you run Claude Code, Codex, and OpenCode side by side without losing track of sessions, files, branches, diffs, or pull requests.

<table>
  <tr>
    <td width="50%"><img src="https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/list-view.png" alt="Tessera list view"></td>
    <td width="50%"><img src="https://unpkg.com/@horang-labs/tessera@latest/docs/assets/readme/kanban-board.png" alt="Tessera Kanban board"></td>
  </tr>
</table>

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

## Resources

| Link | Purpose |
|------|---------|
| [Download Latest Release](https://github.com/horang-labs/tessera/releases) | Download the desktop app for Windows, macOS, or Linux |
| [npm package](https://www.npmjs.com/package/@horang-labs/tessera) | Run Tessera in the browser |
| [Product Hunt launch][product-hunt] | Support the launch on Product Hunt |
| [Team design partner waitlist][design-partner-waitlist] | Help shape team workspaces and enterprise workflows |
| [GitHub Issues](https://github.com/horang-labs/tessera/issues) | Report bugs and feature requests |
| [Good first issues][good-first-issues] | Find starter-sized docs, QA, and polish tasks |
| [Help wanted][help-wanted] | Find community-friendly areas where maintainer context helps |
| [Discussions][discussions] | Ask questions and propose workflows |
| [Contributing][contributing] | Set up the project and send focused pull requests |

## Install

### Desktop app

Download from [GitHub Releases](https://github.com/horang-labs/tessera/releases).

| Platform | Asset |
|----------|-------|
| Windows, including WSL | Portable `.exe` |
| macOS | `.dmg` for Apple Silicon or Intel |
| Linux beta | `.deb` |

Windows builds are not code-signed yet, so SmartScreen may show an unknown-publisher warning. macOS builds are signed and notarized with Apple Developer ID.

Release downloads, excluding npm installs, as of 2026-05-15 00:28 UTC:

| Version | Windows | macOS | Linux | Total |
|---------|--------:|------:|------:|------:|
| 0.1.0 | 8 | 6 | 0 | 14 |
| 0.1.1 | 14 | 13 | 0 | 27 |
| 0.1.2 | 6 | 9 | 1 | 16 |
| 0.1.3 | 24 | 21 | 5 | 50 |
| 0.1.4 | 30 | 27 | 2 | 59 |
| 0.1.5 | 27 | 62 | 9 | 98 |
| **Total** | **109** | **138** | **17** | **264** |

### Browser runtime

Requires Node.js 20 or later and npm 10 or later.

```bash
npm install -g @horang-labs/tessera
tessera
```

Open the printed local URL.

### Docker Compose

```bash
mkdir -p data/config data/local data/ssh data/codex data/tessera workspaces
touch data/gitconfig
docker compose up --build -d
```

Open `http://127.0.0.1:32123`. If bind mounts are not writable:

```bash
sudo chown -R 1000:1000 data workspaces
```

## First Run

On first run, Tessera guides you through:

1. Creating a local account for the browser runtime.
2. Checking that a supported CLI is installed and authenticated.
3. Selecting a project folder.
4. Starting a chat or worktree-backed task.

Authenticate provider CLIs first, for example with `claude login`, `codex login`, or OpenCode's configured provider credentials.

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

| Provider | Local command | Status | Notes |
|----------|---------------|--------|-------|
| Claude Code | `claude` | Supported | Uses streaming JSON mode, permission modes, plan approval, `AskUserQuestion` prompts, and installed skill discovery |
| Codex | `codex` | Supported | Uses `app-server` JSON-RPC events, approval requests, plan deltas, sandbox/access controls, and reasoning effort |
| OpenCode | `opencode` | Supported | Uses ACP JSON-RPC, OpenCode modes, permission presets, and the models/providers configured in OpenCode |

Provider-specific implementation lives under `src/lib/cli/providers/`. The rest of the app talks to the shared provider contract instead of CLI-specific internals.

## Build From Source

For development, clone the repository and install dependencies:

Source development requires Node.js 20 or later and npm 10 or later.

```bash
git clone https://github.com/horang-labs/tessera.git
cd tessera
npm install
```

Tessera uses a custom Node.js server for the Next.js app, WebSocket transport, database initialization, provider bootstrapping, and background pollers. The dev script starts that server:

```bash
npm run dev
```

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

Published npm and desktop builds include anonymous PostHog telemetry for minimal usage measurement, stored in the US region. You can disable telemetry during onboarding or later in Settings.

Telemetry is limited to basic app usage duration. Tessera does not collect click data, detailed usage patterns, prompts, messages, file paths, command output, repository names, or account details.

Provider requests are handled by the Claude Code, Codex, or OpenCode CLIs installed on your machine. Tessera does not replace their authentication, billing, model access, or network behavior.

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

**CLI is not detected**

Install and authenticate Claude Code, Codex, or OpenCode. If Tessera still cannot find it, open Settings and set the CLI path manually.

**Provider stays logged out**

Run the provider login command, for example `claude login`, `codex login`, or your OpenCode provider setup, then refresh provider status.

**Still stuck?**

Please open a [GitHub Issue](https://github.com/horang-labs/tessera/issues) with your OS, Tessera version, runtime, provider CLI, and the error you see.

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
