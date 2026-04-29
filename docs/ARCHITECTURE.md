# Architecture

## 1. Overview

This project (package name **`tessera`**, distributed as the Tessera desktop app) is a web-based UI for AI coding agent CLIs. It spawns CLI processes on the server, communicates with them over stdin/stdout using each CLI's native protocol, and relays messages to the browser over WebSocket. The frontend provides a multi-tab, multi-panel IDE-like experience with a sidebar organizing sessions by project, a kanban task board, collections for grouping sessions, archive/worktree management, and real-time streaming of assistant responses, tool calls, and thinking blocks.

**CLI providers currently registered** (`src/lib/cli/providers/bootstrap.ts`):

- **`claude-code`** — Claude Code CLI, using the Anthropic streaming JSON protocol (`--output-format stream-json --input-format stream-json`).
- **`codex`** — Codex CLI, using the `codex app-server` JSON-RPC 2.0 protocol (`initialize → thread/start → turn/start`).

Additional providers (Gemini CLI, OpenCode, …) plug in behind the same `CliProvider` interface. Session metadata is persisted in a local SQLite database via `sql.js`; conversation history can live either in the CLI's own JSONL files (Claude Code) or in the DB (`conversation_messages` table).

The app also ships as an **Electron desktop application** (`electron/main.ts`) that boots an embedded Next.js+WebSocket server as a child process and exposes a system tray. See §13.

## 2. System Architecture Diagram

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                           Browser                                  │
 │                                                                    │
 │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
 │  │ Zustand   │  │ Tab/Panel│  │ Chat Area│  │  Kanban Board    │   │
 │  │ Stores    │  │ System   │  │ Messages │  │  (DnD sessions)  │   │
 │  └─────┬────┘  └──────────┘  └──────────┘  └──────────────────┘   │
 │        │                                                           │
 │  ┌─────▼──────────────────────────────────────────────────────┐    │
 │  │              WebSocket Client (ws/client.ts)               │    │
 │  └─────────────────────────┬──────────────────────────────────┘    │
 └────────────────────────────┼───────────────────────────────────────┘
                              │ wss://host/ws (JSON messages)
 ┌────────────────────────────┼───────────────────────────────────────┐
 │  Server (server.ts)        │                                       │
 │  ┌─────────────────────────▼──────────────────────────────────┐    │
 │  │            WebSocket Server (ws/server.ts)                 │    │
 │  │  - JWT auth on upgrade                                     │    │
 │  │  - Route ClientMessage → handler                           │    │
 │  │  - Broadcast ServerMessage per userId                      │    │
 │  └──────┬──────────────────────────────────┬──────────────────┘    │
 │         │                                  │                       │
 │  ┌──────▼──────────┐            ┌──────────▼────────────┐          │
 │  │ ProcessManager   │◄──────────│  ProtocolAdapter       │          │
 │  │ (cli/process-    │  stdout   │  (cli/protocol-        │          │
 │  │  manager.ts)     │──────────►│   adapter.ts)          │          │
 │  │                  │           │                        │          │
 │  │ - spawn/kill CLI │           │ - Parse stream-json    │          │
 │  │ - stdin queue    │           │ - Route by msg.type    │          │
 │  │ - health check   │           │ - stream_event deltas  │          │
 │  └──────┬──────────┘            │ - control_request/     │          │
 │         │ stdin (JSON)          │   control_response     │          │
 │         │                       └───────────────────────┘           │
 │  ┌──────▼──────────┐                                               │
 │  │  CLI Process     │ ◄──► AI API (Anthropic, OpenAI, etc.)        │
 │  │  (claude / codex │                                               │
 │  │   / gemini / …)  │                                               │
 │  └─────────────────┘                                               │
 │                                                                    │
 │  ┌──────────────────┐    ┌───────────────────────────────┐         │
 │  │  SQLite (sql.js)  │    │  CLI-owned storage             │         │
 │  │  ~/.tessera/     │    │  e.g. ~/.claude/projects/      │         │
 │  │  tessera.db         │    │       {encoded-dir}/{id}.jsonl │         │
 │  └──────────────────┘    └───────────────────────────────┘         │
 │                                                                    │
 │  ┌──────────────────────────────────────────────────────────┐      │
 │  │              Next.js App (App Router)                     │      │
 │  │  - API Routes (/api/*)                                    │      │
 │  │  - Pages (/chat, /login, /setup)                          │      │
 │  └──────────────────────────────────────────────────────────┘      │
 └────────────────────────────────────────────────────────────────────┘
```

## 3. Server Architecture

The server is a custom Node.js HTTP server (`server.ts`) that hosts both Next.js and a WebSocket server on the same port.

**Entry point: `server.ts`**

1. Initializes Next.js via `next()` and calls `app.prepare()`.
2. Creates an HTTP server with `createServer()` — all HTTP requests are delegated to Next.js's request handler.
3. On the `upgrade` event, routes `/ws` to the custom WebSocket server and everything else (e.g., `/_next/webpack-hmr`) to Next.js HMR.
4. Calls `wsServer.start(httpServer)` to attach the `ws` library WebSocket server.
5. Starts a rate-limit poller that broadcasts usage data to all connected clients.
6. Registers graceful shutdown handlers (`SIGINT`, `SIGTERM`) that close WebSocket connections, stop the poller, kill all CLI processes, and close the HTTP server.

**Why a custom server?** Next.js's built-in server does not support WebSocket upgrades. The custom server allows the `ws` library to share the same port, which is critical for CLI process communication.

**Singleton survival:** All stateful singletons (`processManager`, `protocolAdapter`, `sessionReader`, `sessionOrchestrator`, `wsServer`, database) use `Symbol.for()` on `globalThis` to survive Next.js hot-module replacement during development.

## 4. CLI Integration Layer

The CLI integration layer lives in `src/lib/cli/` and follows an adapter pattern to keep the Tessera decoupled from any specific CLI.

### 4.1 ProcessManager (`process-manager.ts`, split across multiple files)

Manages the lifecycle of CLI child processes independently of which provider owns them:

- **Spawn**: `createSession()` calls `provider.spawn(workDir, options)` which returns a spawned `ChildProcess`. The provider decides the exact arg list (`provider.getCliArgs()`); for Claude Code this is `--print --output-format stream-json --input-format stream-json --permission-prompt-tool stdio …`, for Codex it's `app-server` + JSON-RPC init.
- **Resume**: `resumeSession()` delegates to the provider's resume hook (Claude Code: `--resume <sessionId>`). Codex sessions are resumed by replaying `thread/start` with the stored thread ID.
- **Stdin queue**: Messages are queued per session and flushed one at a time with backpressure handling (`drain` event). Serialization format is provider-specific — providers implement `sendMessage(proc, content)` to emit the right framing.
- **Control / config updates**: `updateSessionConfig(proc, { permissionMode, model, reasoningEffort })` is an optional per-provider hook. `sendApprovalResponse` and `sendInterrupt` are also provider-delegated.
- **Health check**: A ~5-second interval sends signal 0 to each process PID.
- **Graceful kill**: `SIGTERM` to the process group, then `pkill -s` by session ID, then recursive descendant kill. Falls back to `SIGKILL` after 5 seconds.
- **Limits**: Max 20 concurrent processes, max 100 queued stdin messages.
- **WSL/Windows routing**: The spawn layer is aware of WSL environments and can route to a Windows-native CLI binary via `wsl.exe` fallback when the Linux-side binary isn't available.

### 4.2 ProtocolAdapter (`protocol-adapter.ts`, split across ~8 files)

Parses CLI stdout line by line and translates CLI-native messages into `ServerMessage` types for the WebSocket layer. The adapter itself is provider-agnostic: it calls `provider.parseStdout(line)` / `provider.parseSessionStdout(sessionId, line)` and each provider returns a list of `ParsedMessage` values. The adapter then applies the declared side effects (send to user, update usage, etc.). This keeps the WebSocket server free of per-CLI parsing logic.

Per-file breakdown: `protocol-adapter.ts` (entry), `protocol-adapter-stream.ts`, `protocol-adapter-tools.ts`, `protocol-adapter-turn-lifecycle.ts`, plus per-provider parsers in `providers/claude-code/protocol-parser.ts` and `providers/codex/protocol-parser.ts`.

**Claude Code message routing (claude-code/protocol-parser.ts):**

| CLI stdout type    | WebSocket output                  |
|--------------------|-----------------------------------|
| `system`           | `system` (init, warnings, errors) |
| `assistant`        | `tool_call` (running), `thinking` |
| `stream_event`     | `message` (text deltas), `thinking` / `thinking_update`, `context_usage` |
| `result`           | `notification` (completed + usage)|
| `tool_result`      | `tool_call` (completed/error)     |
| `control_request`  | `interactive_prompt`              |
| `progress`         | `progress_hook`, `notification`   |
| `user`             | `tool_call` (completed)           |

**Stream event handling**: With `--include-partial-messages`, Claude Code emits Anthropic API streaming events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`). The adapter tracks per-session state (`activeThinkingId`, `isStreamingText`, `processedToolUseIds`) to correctly merge deltas and prevent duplicates.

**Control request/response**: When the CLI needs permission (tool execution approval) or user input (`AskUserQuestion`), it sends a `control_request`. The adapter stores the `requestId` in `ProcessInfo.pendingPermissionRequests` and forwards an `interactive_prompt` to the frontend. When the user responds, `ws/server.ts` translates the response into a `control_response` written to CLI stdin (via the provider's `sendApprovalResponse` hook).

**Codex message routing**: Codex speaks JSON-RPC 2.0 over stdout. The Codex parser maps `initialize.response`, `thread.started`, `turn.started`, `turn.content_delta`, `turn.tool_call`, `turn.completed`, and `turn.interrupt_request` into the same `ParsedMessage` shape so the UI can render both providers uniformly.

### 4.3 MessageParser (`message-parser.ts`)

Pure functions (zero dependencies) for parsing content blocks from CLI JSONL:
- `parseContentBlock()` / `parseContentBlocks()` — discriminated union of `text`, `tool_use`, `thinking`, `redacted_thinking`
- `extractToolResultOutput()` / `extractToolResults()` — extracts tool result data from user message content blocks
- `extractOutputString()` — normalizes string/array content to plain text

Shared by both the real-time `ProtocolAdapter` and the batch `SessionReader`.

### 4.4 SessionReader (`session-reader.ts`)

Reads CLI-generated JSONL session files from `~/.claude/projects/{encoded-dir}/{sessionId}.jsonl`:
- `readSession()` — full history parse into `EnhancedMessage[]`
- `readSessionPaginated()` — byte-offset pagination for large sessions (reads from file tail)
- `readToolOutput()` — lazy-loads a specific tool's output by `toolUseId`
- `readSessionUsage()` — extracts token usage from the last assistant entry
- `exportSession()` — generates a Markdown export with mtime-based caching

### 4.5 Provider Registry and CliProvider Contract

Multi-CLI support is implemented through the `CliProvider` interface (`src/lib/cli/providers/provider-contract.ts`) and a singleton registry (`registry.ts`). Each provider implements a set of hooks covering spawn, stdin write, stdout parse, title generation, status/health check, optional session config updates, approval responses, interrupts, and skill-source construction.

Key interface methods:

| Method | Purpose |
|---|---|
| `getProviderId()` / `getDisplayName()` | Machine-readable ID + UI label |
| `isAvailable()` | Quick "is the binary installed?" check |
| `checkStatus({ environment })` | Three-state (`connected` / `needs_login` / `not_installed`) health probe, supports both native and WSL environments |
| `getCliArgs(options)` / `spawn(workDir, options)` | Build argv and spawn the child process |
| `sendMessage(proc, content)` | Write a user turn to stdin in the CLI's native format |
| `parseStdout(line)` / `parseSessionStdout(sessionId, line)` | Pure parsers — must not do I/O; return `ParsedMessage[]` describing side effects |
| `handleSessionExit(sessionId, exitCode)` | Cleanup hook for provider-owned parser state |
| `generateTitle(prompt, userId)` | AI-assisted session title generation |
| `updateSessionConfig(proc, patch)` | Optional: change permission mode / model / reasoning effort mid-session |
| `sendApprovalResponse(proc, requestId, decision)` | Optional: reply to a pending permission prompt |
| `sendInterrupt(proc, sessionId)` | Optional: cancel the current turn |
| `createSkillSource(sessionId, proc)` | Optional: expose the CLI's skill catalog to the UI |
| `onSessionReady(proc, sessionId)` | Optional: provider-specific post-spawn init |

Registry behavior (`registry.ts`):

- Stored on `globalThis` with a `Symbol.for()` key so HMR in development does not duplicate registrations.
- `registerIfAbsent(id, factory)` is idempotent — bootstrap can be imported many times safely.

Bootstrap (`bootstrap.ts`) wires the default providers at server startup:

```ts
cliProviderRegistry.registerIfAbsent(claudeCodeAdapter.getProviderId(), () => claudeCodeAdapter);
cliProviderRegistry.registerIfAbsent(codexAdapter.getProviderId(), () => codexAdapter);
```

Other architectural guarantees:

- The database schema carries a `provider` column on both `projects` and `sessions` so every record is owned by a specific CLI.
- `SessionReader` only reads CLI-owned JSONL files (Claude Code). Codex and other providers that don't emit JSONL use the DB's `session_messages` / `conversation_messages` tables instead.
- The Tessera **must not** compute CLI-specific filesystem paths itself — it asks the provider or uses the stored `jsonl_path` / `provider_state` values on the session row.

## 5. WebSocket Communication

### 5.1 Server (`ws/server.ts`)

A singleton `WebSocketServer` class wrapping the `ws` library:
- Listens on `/ws` path, attached to the same HTTP server as Next.js.
- Authenticates connections by parsing the `jwt` cookie and verifying with RS256.
- Maintains a `Map<userId, Set<WebSocket>>` for multi-device support.
- Routes incoming `ClientMessage` by `type` to handler methods.
- Verifies session ownership before processing session-scoped messages.
- Ping/pong heartbeat every 30 seconds; terminates dead connections.
- Max payload: 50MB (supports 5 images x 5MB x base64 1.33x overhead).

### 5.2 Client (`ws/client.ts`)

A singleton `WebSocketClient` class used by the browser:
- Connects to `ws[s]://host/ws` using the browser WebSocket API.
- Exponential backoff reconnection (max 5 attempts, 1s-10s delay).
- Dispatches incoming `ServerMessage` to Zustand stores (`useChatStore`, `useSessionStore`, `useNotificationStore`, `useUsageStore`, `useRateLimitStore`, `useSkillAnalysisStore`).
- Optimistic updates: adds user messages to the chat store immediately before the server confirms.

### 5.3 Message Types (`ws/message-types.ts`)

**Client -> Server (11 types):**

| Type                   | Purpose                                      |
|------------------------|----------------------------------------------|
| `create_session`       | Spawn new CLI process                        |
| `close_session`        | Kill CLI process and remove session          |
| `send_message`         | Send user text/images to CLI stdin           |
| `resume_session`       | Resume saved session from JSONL              |
| `retry_session`        | Resume or create if session file missing     |
| `interactive_response` | Respond to permission/question prompts       |
| `mark_as_read`         | Clear unread notification count              |
| `cancel_generation`    | Send SIGINT to CLI                           |
| `set_permission_mode`  | Change CLI permission mode at runtime        |
| `set_model`            | Change CLI model at runtime                  |
| `stop_session`         | Kill CLI process from sidebar                |

**Server -> Client (17 types):**

`session_created`, `session_closed`, `session_stopped`, `session_idle_closed`, `message`, `notification`, `error`, `interactive_prompt`, `cli_down`, `session_history`, `session_list`, `tool_call`, `thinking`, `thinking_update`, `system`, `progress_hook`, `unread_cleared`, `context_usage`, `rate_limit_update`, `skill_analysis_progress`

Content blocks support text and base64-encoded images (`TextContentBlock`, `ImageContentBlock`).

## 6. Database Layer

### 6.1 Engine

SQLite via **`sql.js`** (WASM-compiled SQLite, synchronous API with an in-memory DB snapshot flushed to disk). Database file: `~/.tessera/tessera.db`.

Using `sql.js` instead of a native binding keeps the Electron packaging portable (no per-arch rebuild) at the cost of in-memory operations being single-threaded. The DB is small (session metadata + conversation messages), so this is a deliberate trade-off.

### 6.2 Schema (`src/lib/db/schema.ts`, `SCHEMA_VERSION = 20`)

| Table                  | Purpose                                                               |
|------------------------|-----------------------------------------------------------------------|
| `_meta`                | Key-value store for schema version tracking                           |
| `projects`             | Registered project directories (`id` = absolute path, plus `provider`)|
| `sessions`             | Session metadata (title, provider, work_dir, worktree, task/collection refs, archive flags) |
| `session_messages`     | Per-session append-only message log (used by providers that don't emit JSONL) |
| `conversation_messages`| Historical conversation log (role + content, indexed by session)      |
| `custom_columns`       | User-defined kanban board columns                                     |
| `collections`          | Per-project grouping of sessions (labeled, colored, sortable)         |
| `tasks`                | Kanban task entities that can own multiple sessions                   |

**Key `sessions` columns:**
- `project_id` — links to `projects.id` (no FK constraint for flexibility)
- `provider` — CLI provider ID that owns this session (default `'claude-code'`)
- `provider_state` — JSON blob for provider-specific resume state (e.g. Codex thread ID)
- `title`, `has_custom_title` — auto-generated or user-set title
- `work_dir` — absolute filesystem path for the session's working directory
- `worktree_branch` — git worktree branch if this session is worktree-bound
- `task_id`, `collection_id` — optional foreign refs for kanban grouping
- `archived`, `archived_at`, `worktree_deleted_at`, `deleted` — archive / soft-delete tracking
- `sort_order` — explicit sort within project/status groups

**Key `tasks` columns:** `project_id`, `title`, `collection_id`, `workflow_status` (default `todo`), `worktree_branch`, `archived`, `summary`, `sort_order`.

### 6.3 Migrations (`db/database.ts`)

Sequential migrations run on startup if `schema_version` in `_meta` is behind `SCHEMA_VERSION`. Migrations v2-v20 add columns (`visible`, `work_dir`, `deleted`, `provider`, `provider_state`, `task_id`, `collection_id`, `archived_at`, `worktree_deleted_at`, …), tables (`custom_columns`, `conversation_messages`, `session_messages`, `collections`, `tasks`), and indexes. Historical migrations also introduced `tag` and `session_hashtags`, which were removed again in a later version. Column additions use `PRAGMA table_info` guards for idempotency.

### 6.4 Query Modules

- **`db/sessions.ts`** — CRUD, cursor-based pagination (`getSessionsByProject`), grouped queries by task status, soft-delete.
- **`db/projects.ts`** — Register/hide projects (closing a project sets `visible=0`, not deletion). Sessions are preserved.
- **`db/collections.ts`, `db/tasks.ts`, `db/custom-columns.ts`** — CRUD for kanban grouping entities.
- **`db/session-messages.ts`, `db/conversation-messages.ts`** — Append-only message persistence for providers without their own JSONL (plus historical conversation tracking).

### 6.5 Archive Service

`src/lib/archive/archive-service.ts` runs at server startup and periodically, deleting worktrees whose `worktree_deleted_at` has expired. Archived sessions/tasks keep their DB rows so users can restore them from the archive dashboard (`/chat?view=archive` or via `src/components/archive/`).

## 7. Authentication

### 7.1 JWT (`auth/jwt.ts`)

- **Algorithm**: RS256 (asymmetric — private key signs, public key verifies)
- **Lifetime**: 7 days
- **Issuer/Audience**: `tessera` / `tessera-users`
- **Storage**: `jwt` HTTP cookie
- **Caching**: Verified tokens cached in memory for 60 seconds to avoid repeated crypto operations

### 7.2 Password (`auth/password.ts`)

bcrypt with 10 rounds for hashing and verification.

### 7.3 API Auth (`auth/api-auth.ts`)

`requireAuthenticatedUserId(request)` — extracts the JWT from the cookie, verifies it, and returns `{ userId }` or a 401 `NextResponse`. Used as a guard at the top of every API route handler.

### 7.4 WebSocket Auth

The WebSocket server parses the `cookie` header from the HTTP upgrade request, extracts the `jwt` cookie, and verifies it with the same `verifyToken()`. Connections without a valid token are rejected with close code 1008.

## 8. Frontend Architecture

### 8.1 Next.js App Router

Pages are in `src/app/`:

| Route           | Purpose                          |
|-----------------|----------------------------------|
| `/`             | Redirect to `/chat`              |
| `/chat`         | Main chat interface (tabs, panels, sidebar, kanban, archive) |
| `/login`        | Authentication page              |

All other surfaces (archive dashboard, skill browser, settings, collections, kanban) are rendered inside `/chat` as sidebar views or floating panels rather than separate routes.

### 8.2 Component Hierarchy

```
layout.tsx
├── app-header.tsx (AppHeader — top bar with project selector)
├── tab-bar.tsx (TabBar — browser-like tabs)
│   └── tab-item.tsx (TabItem — individual tab with context menu)
├── tab-panel-host.tsx (TabPanelHost — renders active tab's panel layout)
│   └── panel-wrapper.tsx (PanelWrapper — single panel in split layout)
│       ├── sidebar.tsx (Sidebar — session list grouped by project)
│       │   ├── project-group.tsx (collapsible project folder)
│       │   │   ├── status-group.tsx (sessions by task_status)
│       │   │   └── session-item.tsx / task-item.tsx
│       ├── chat-layout.tsx (ChatLayout — main content area)
│       │   ├── header.tsx (session title, controls)
│       │   ├── message-list.tsx (virtualized message list)
│       │   │   ├── message-bubble.tsx (user/assistant text)
│       │   │   ├── tool-call-block.tsx (collapsible tool execution)
│       │   │   ├── thinking-block.tsx (extended thinking display)
│       │   │   └── system-message-block.tsx
│       │   ├── message-input.tsx (text input + image paste + voice)
│       │   ├── permission-floating-bar.tsx
│       │   └── ask-user-question-floating-panel.tsx
│       └── kanban-board.tsx (KanbanBoard — drag-and-drop task board)
│           ├── kanban-column.tsx (status column)
│           └── kanban-card.tsx (session card)
```

### 8.3 Multi-Panel System

The UI supports split panels within each tab:
- **`panel-store.ts`** — manages panel layout tree (`PanelNode`), panel-session assignments, and the active panel
- **`tab-store.ts`** — manages browser-style tabs, each containing a snapshot of the panel layout; LRU eviction for inactive tabs
- Panels can be split horizontally/vertically; each panel independently displays a session's chat or an empty state
- Tab switching writes back the active tab's live panel state to the tab's snapshot, then loads the target tab's snapshot

## 9. State Management

All client state is managed with Zustand stores in `src/stores/`:

| Store                    | Responsibility                                                    |
|--------------------------|-------------------------------------------------------------------|
| `chat-store.ts`          | Per-session message arrays, streaming state (buffered 50ms debounce), waiting-for-response indicators, interactive prompts, draft inputs, scroll positions, tool output cache, read-only pagination |
| `session-store.ts`       | Project groups with sessions, active session selection, unread counts, task status/archive/move operations (optimistic updates with rollback), AI title generation tracking |
| `tab-store.ts`           | Browser-like tabs with LRU tracking, per-project tab states, preview tabs (single-click = preview, double-click = pin), localStorage persistence (v2 format with per-project state) |
| `panel-store.ts`         | Panel layout tree, panel-session assignments, split/close operations |
| `board-store.ts`         | Kanban board view mode toggle and column configuration             |
| `custom-column-store.ts` | CRUD for user-defined kanban columns                               |
| `notification-store.ts`  | Toast notifications, sound alerts, per-session notification queue   |
| `usage-store.ts`         | Per-session token usage and context window metrics                  |
| `rate-limit-store.ts`    | API rate limit utilization (5-hour and 7-day windows)              |
| `settings-store.ts`      | User preferences (theme, language, etc.)                           |
| `auth-store.ts`          | Current user info and auth state                                   |
| `skill-analysis-store.ts`| Skill scanning/analysis progress and results                       |

**Key patterns:**
- Optimistic updates with server sync and rollback on error (`updateTaskStatus`, `moveSession`, `toggleArchive`, `updateSessionHashtags`)
- Stream buffering with 50ms debounce to batch rapid text deltas into fewer React re-renders
- `Map<sessionId, ...>` for per-session isolation of messages, prompts, drafts, and scroll positions

## 10. API Routes

All routes are authenticated via JWT cookie (except login/logout).

### Auth

| Method | Path                | Purpose                    |
|--------|---------------------|----------------------------|
| POST   | `/api/auth/login`   | Authenticate and set JWT   |
| POST   | `/api/auth/logout`  | Clear JWT cookie           |
| GET    | `/api/auth/me`      | Get current user info      |

### Sessions

| Method | Path                                     | Purpose                                  |
|--------|------------------------------------------|------------------------------------------|
| POST   | `/api/sessions`                          | Create a new session                     |
| DELETE | `/api/sessions/[id]`                     | Delete a session                         |
| GET    | `/api/sessions/[id]/messages`            | Get paginated session messages           |
| POST   | `/api/sessions/[id]/resume`              | Resume a stopped session                 |
| PATCH  | `/api/sessions/[id]/rename`              | Rename a session                         |
| PATCH  | `/api/sessions/[id]/archive`             | Toggle archive flag                      |
| PATCH  | `/api/sessions/[id]/move`                | Move session to different project        |
| PATCH  | `/api/sessions/[id]/collection`          | Assign session to a collection           |
| POST   | `/api/sessions/[id]/export`              | Export session as Markdown               |
| POST   | `/api/sessions/[id]/generate-title`      | AI-generate a session title              |
| GET    | `/api/sessions/[id]/tool-output`         | Lazy-load tool output by toolUseId       |
| GET    | `/api/sessions/[id]/git`                 | Git status / diff stats for the session's worktree |
| GET    | `/api/sessions/[id]/skills`              | Skill metadata for the session's CLI     |
| POST   | `/api/sessions/reorder`                  | Bulk reorder sessions within a project   |

### Projects

| Method | Path                                        | Purpose                              |
|--------|---------------------------------------------|--------------------------------------|
| GET    | `/api/sessions/projects`                    | List all projects with sessions      |
| GET    | `/api/sessions/projects/[encodedDir]`       | Get sessions for a project (paginated)|
| DELETE | `/api/sessions/projects/[encodedDir]`       | Hide a project from sidebar          |

### Collections & Tasks

| Method | Path                                  | Purpose                                       |
|--------|---------------------------------------|-----------------------------------------------|
| GET/POST/PATCH/DELETE | `/api/collections`      | CRUD for per-project session collections      |
| GET/POST/PATCH/DELETE | `/api/tasks`            | CRUD for kanban tasks (each task can own multiple sessions) |
| GET/POST/PATCH/DELETE | `/api/columns`          | CRUD for custom kanban columns                |

### Providers

| Method | Path                                       | Purpose                                              |
|--------|--------------------------------------------|------------------------------------------------------|
| GET    | `/api/providers/session-options`           | List CLI provider models / permission modes / etc.   |

### Archive, Worktrees & Filesystem

| Method | Path                      | Purpose                                       |
|--------|---------------------------|-----------------------------------------------|
| GET/POST | `/api/archive`          | List and restore archived sessions / worktrees |
| POST   | `/api/worktrees`          | Create a git worktree                          |
| GET    | `/api/filesystem/browse`  | Browse filesystem directories                  |

### Settings, Skills & STT

| Method | Path                      | Purpose                             |
|--------|---------------------------|-------------------------------------|
| GET    | `/api/settings`           | Get user settings                   |
| PUT    | `/api/settings`           | Update user settings                |
| GET    | `/api/skills`             | List available CLI skills           |
| GET    | `/api/skills/analyze`     | Get cached skill analysis           |
| POST   | `/api/skills/analyze`     | Trigger skill analysis              |
| DELETE | `/api/skills/analyze`     | Cancel running analysis             |
| POST   | `/api/stt`                | Speech-to-text transcription (Gemini) |
| POST   | `/api/upload`             | Upload image attachments for chat   |

## 11. Key Data Flows

### 11.1 User Sends a Message

```
Browser                    WS Server                ProcessManager        CLI Process
   │                          │                          │                     │
   │ send_message             │                          │                     │
   │ (sessionId, content)     │                          │                     │
   │─────────────────────────►│                          │                     │
   │                          │ verify ownership         │                     │
   │                          │ append to session log    │                     │
   │                          │ auto-set title (DB)      │                     │
   │                          │                          │                     │
   │                          │ sendMessage(sessionId,   │                     │
   │                          │   content)               │                     │
   │                          │─────────────────────────►│                     │
   │                          │                          │ queue + flush stdin  │
   │                          │                          │ {"type":"user",     │
   │                          │                          │  "message":{...}}   │
   │                          │                          │────────────────────►│
   │                          │                          │                     │
   │                          │                          │    stdout lines     │
   │                          │                          │◄────────────────────│
   │                          │         ProtocolAdapter  │                     │
   │                          │◄─────── parseStdout()    │                     │
   │                          │                          │                     │
   │  stream_event deltas     │                          │                     │
   │  (message, thinking,     │                          │                     │
   │   tool_call, etc.)       │                          │                     │
   │◄─────────────────────────│                          │                     │
   │                          │                          │                     │
   │  notification            │                          │                     │
   │  (completed + usage)     │                          │                     │
   │◄─────────────────────────│                          │                     │
```

1. Client calls `wsClient.sendMessage()` — optimistically adds user message to `chatStore`, sets `waitingForResponse`.
2. Server receives `send_message`, verifies session ownership, appends to session log, auto-generates title if first message.
3. `processManager.sendMessage()` queues the content and writes `{"type":"user","message":{"role":"user","content":...}}\n` to CLI stdin.
4. CLI processes the request and streams responses on stdout.
5. `protocolAdapter.parseStdout()` parses each JSON line and emits WebSocket messages:
   - `stream_event` content_block_delta -> `message` (text) or `thinking_update`
   - `assistant` snapshot -> `tool_call` (running)
   - `tool_result` -> `tool_call` (completed/error)
   - `result` -> `notification` (completed with token usage)
6. Client's `handleMessage()` dispatches to stores; `chatStore` batches text deltas with 50ms debounce.

### 11.2 Session Resume from JSONL

```
Browser                    WS Server             SessionReader         CLI Process
   │                          │                       │                    │
   │ resume_session           │                       │                    │
   │ (sessionId)              │                       │                    │
   │─────────────────────────►│                       │                    │
   │                          │ readSession()         │                    │
   │                          │──────────────────────►│                    │
   │                          │                       │ find JSONL file    │
   │                          │                       │ across project dirs│
   │                          │  EnhancedMessage[]    │                    │
   │                          │◄──────────────────────│                    │
   │                          │                       │                    │
   │                          │ resumeSession()       │                    │
   │                          │ (processManager)      │                    │
   │                          │──────────────────────────────────────────►│
   │                          │                       │  claude --resume   │
   │                          │                       │  --session-id ...  │
   │                          │                       │                    │
   │  session_history         │                       │                    │
   │  (messages[])            │                       │                    │
   │◄─────────────────────────│                       │                    │
   │                          │                       │                    │
   │  chatStore.loadHistory() │                       │                    │
```

1. Client sends `resume_session` with the session ID.
2. Server reads the JSONL file using `sessionReader.readSession()`, which parses `user`/`assistant` entries into `EnhancedMessage[]` (text, tool_call, thinking blocks).
3. Server spawns `claude --resume <sessionId>` via `processManager.resumeSession()`.
4. Server sends `session_history` containing the parsed messages to the client.
5. Client calls `chatStore.loadHistory()` to populate the message list.
6. The resumed CLI process is ready for new user messages on stdin.

### 11.3 Kanban Drag-and-Drop (Task Status Change)

```
Browser (Kanban Board)      sessionStore          API Server            SQLite
   │                           │                      │                   │
   │ drag card to new column   │                      │                   │
   │──────────────────────────►│                      │                   │
   │                           │ optimistic update:   │                   │
   │                           │ - move session to    │                   │
   │                           │   new taskStatus     │                   │
   │                           │ - adjust countByStatus│                  │
   │                           │ - auto-stop CLI if   │                   │
   │                           │   "done"/"cancelled" │                   │
   │                           │                      │                   │
   │  UI re-renders instantly  │ PATCH /api/sessions/ │                   │
   │                           │ [id]/task-status     │                   │
   │                           │─────────────────────►│                   │
   │                           │                      │ updateSession()   │
   │                           │                      │──────────────────►│
   │                           │                      │                   │
   │                           │       200 OK         │                   │
   │                           │◄─────────────────────│                   │
   │                           │                      │                   │
   │                    (on error: rollback optimistic │                   │
   │                     update + show toast)          │                   │
```

1. User drags a kanban card from one column to another.
2. `sessionStore.updateTaskStatus()` performs an optimistic update: moves the session to the new `taskStatus`, adjusts `countByStatus` counts, and auto-stops the CLI process for terminal statuses (`done`, `cancelled`).
3. A `PATCH /api/sessions/[id]/task-status` request is sent to the server.
4. The server updates the `sessions.task_status` column in SQLite.
5. If the request fails, the store rolls back to the previous status and shows a toast.

## 12. Directory Structure

```
tessera/
├── server.ts                    # Custom HTTP+WS server entry point
├── src/
│   ├── app/                     # Next.js App Router
│   │   ├── layout.tsx           # Root layout
│   │   ├── page.tsx             # Root redirect
│   │   ├── chat/                # Main chat page
│   │   ├── login/               # Auth page
│   │   ├── setup/               # First-run setup and readiness checks
│   │   └── api/                 # REST API routes
│   │       ├── auth/            #   login, logout, me
│   │       ├── sessions/        #   CRUD, messages, resume, projects
│   │       ├── collections/     #   Session collections
│   │       ├── tasks/           #   Kanban tasks
│   │       ├── settings/        #   User preferences
│   │       ├── skills/          #   Skill listing and analysis
│   │       ├── stt/             #   Speech-to-text
│   │       ├── filesystem/      #   Directory browser
│   │       └── worktrees/       #   Git worktree creation
│   ├── components/              # React components
│   │   ├── layout/              #   App header, running process panel
│   │   ├── tab/                 #   Tab bar, tab items, context menus
│   │   ├── panel/               #   Split panel system
│   │   ├── chat/                #   Sidebar, messages, input, tool blocks
│   │   │   ├── progress/        #     Progress indicators
│   │   │   ├── shared/          #     Shared chat utilities
│   │   │   └── tool-results/    #     Tool-specific result renderers
│   │   ├── board/               #   Kanban board, columns, cards
│   │   ├── notifications/       #   Toast notifications
│   │   ├── settings/            #   Settings dialog
│   │   ├── setup/               #   Setup flow UI
│   │   ├── skills/              #   Skill picker, analysis UI
│   │   ├── keyboard/            #   Keyboard shortcut overlay
│   │   ├── auth/                #   Login form
│   │   └── ui/                  #   Shared UI primitives
│   ├── stores/                  # Zustand state management
│   │   ├── chat-store.ts        #   Messages, streaming, prompts
│   │   ├── session-store.ts     #   Projects, sessions
│   │   ├── tab-store.ts         #   Browser-like tabs, LRU
│   │   ├── panel-store.ts       #   Split panel layout
│   │   ├── board-store.ts       #   Kanban view state
│   │   ├── notification-store.ts#   Toasts and sounds
│   │   ├── usage-store.ts       #   Token usage tracking
│   │   ├── rate-limit-store.ts  #   API rate limits
│   │   └── ...                  #   auth, settings, skills, collections
│   ├── hooks/                   # Custom React hooks
│   ├── lib/                     # Core libraries
│   │   ├── ws/                  #   WebSocket server + client + types
│   │   ├── cli/                 #   CLI process management + parsing
│   │   │   ├── process-manager.ts
│   │   │   ├── protocol-adapter.ts
│   │   │   ├── providers/
│   │   │   ├── protocol-message-types.ts
│   │   │   └── types.ts
│   │   ├── db/                  #   SQLite database + schema + queries
│   │   ├── auth/                #   JWT, bcrypt, API auth guard
│   │   ├── session/             #   Session orchestrator + title generator
│   │   ├── skill/               #   Skill scanning and analysis
│   │   ├── rate-limit/          #   Rate limit polling
│   │   ├── settings/            #   Settings file management
│   │   ├── i18n/                #   Internationalization
│   │   ├── keyboard/            #   Keyboard shortcut definitions
│   │   ├── chat/                #   Chat utility functions
│   │   ├── constants/           #   Shared constants
│   │   ├── http/                #   HTTP utilities
│   │   └── validation/          #   Input validation
│   └── types/                   # TypeScript type definitions
│       ├── chat.ts              #   Message types (EnhancedMessage union)
│       ├── tab.ts               #   Tab and snapshot types
│       ├── panel.ts             #   Panel layout types
│       ├── task.ts              #   Task status and tag types
│       ├── auth.ts              #   JWT payload types
│       └── ...
├── electron/                    # Electron desktop wrapper
│   ├── main.ts                  #   Electron main process
│   ├── server-child.ts          #   Spawns the Next.js+WS server as a child
│   ├── preload.ts               #   Preload bridge (typed IPC)
│   └── tray.ts                  #   System tray integration
│   └── electron/                #   Electron-specific specs
├── docs/                        # Documentation
├── public/                      # Static assets
└── package.json                 # name: "tessera"
```

## 13. Electron Desktop App

Tessera ships as an Electron desktop app in addition to running in the browser.

**Entry point**: `electron/main.ts`

Lifecycle:

1. Main process spawns `electron/server-child.ts` (a Node child process), which runs the same Next.js + WebSocket server that powers the web build.
2. Once the server reports ready, the renderer opens `http://localhost:<port>` pointing at the embedded server.
3. `electron/preload.ts` exposes a small typed IPC surface to the renderer (`window.tessera.*`) for desktop-only features.
4. `electron/tray.ts` installs a system tray icon with show/hide/quit.

**Development**:

```bash
npm run electron:dev
# Concurrently starts:
#   NODE_ENV=development PORT=3100 npx tsx server.ts    (SERVER)
#   wait-on http://localhost:3100 && TESSERA_DEV_PORT=3100 electron .    (ELECTRON)
```

**Build** (electron-builder):

```bash
npm run electron:build:win         # Windows portable x64
npm run electron:build:mac-arm64   # macOS Apple Silicon
npm run electron:build:mac-x64     # macOS Intel
npm run electron:build:all         # All targets
```

Packaging notes:

- `asar: true` with `sql.js` explicitly in `asarUnpack` so the WASM binary can be read at runtime.
- `npmRebuild: false` because the app deliberately avoids native modules (hence `sql.js` and `bcryptjs` instead of `better-sqlite3` / `bcrypt`).
- Build output: `release/` (git-ignored).

**WSL → Windows CLI routing**: When Tessera runs as a Linux desktop app inside WSL but the user's CLI binaries (Claude Code, Codex) are installed on the Windows host, `ProcessManager`'s spawn layer can invoke them via `wsl.exe` fallback so the same UI works across environments.
