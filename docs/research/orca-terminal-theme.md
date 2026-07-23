# Orca terminal/provider theme coordination

Checked on 2026-07-14 against the official [`stablyai/orca`](https://github.com/stablyai/orca) repository at current `HEAD` commit [`9924b07bccb8833ac189391ced9750baea059c67`](https://github.com/stablyai/orca/commit/9924b07bccb8833ac189391ced9750baea059c67) (`1.4.139-rc.2`), and against the installed `/Applications/Orca.app` version `1.4.137`. The installed release maps to annotated tag `v1.4.137`, commit [`6013055491943336660e12e5dec93c9ece4575bb`](https://github.com/stablyai/orca/commit/6013055491943336660e12e5dec93c9ece4575bb). A diff between that release commit and current `HEAD` found no changes in the theme, OSC 10/11, mode 2031, terminal options, or appearance-application files discussed below.

## Conclusion

Orca does **not** recolor provider output to match the Orca UI. It coordinates two independently rendered layers:

1. Orca resolves its app mode (`dark`, `light`, or the system preference) and chooses a complete xterm palette, with separate dark and light terminal themes by default.
2. It tells cooperative TUIs what that terminal currently looks like through OSC 10/11 foreground/background query replies at startup and while visible.
3. It tells subscribed TUIs about later dark/light mode flips through the Contour/Kitty DEC mode 2031 protocol (`CSI ?997;1n` dark, `CSI ?997;2n` light).
4. The TUI remains responsible for choosing and redrawing its own explicit RGB colors, including diff backgrounds.

This is why Orca normally avoids a dark terminal with a provider's light composer/diff palette: it makes the provider's startup theme detection reliable and supports live mode-change notification. It is **not** a final rendering clamp. If a provider ignores the queries, does not subscribe to mode 2031, caches the wrong mode, or has already put light truecolor backgrounds into xterm cells, Orca has no color-remapping layer that guarantees a match.

## Verified facts

### 1. Orca owns a full xterm theme, separate from the app's general UI theme

`resolveEffectiveTerminalAppearance` derives a resolved app mode from `settings.theme` plus `prefers-color-scheme`. When the app is light and `terminalUseSeparateLightTheme` is enabled, it chooses `terminalThemeLight`; otherwise it chooses `terminalThemeDark`. The product defaults are a separate `Ghostty Default Style Dark` and `Builtin Tango Light`, with separate divider colors. [Theme resolution](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/lib/terminal-theme.ts#L111-L141), [default settings](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/shared/constants.ts#L238-L243)

The default dark terminal is background `#282c34`, foreground `#ffffff`; the default light terminal is background `#ffffff`, foreground `#2e3434`. Both define all 16 named ANSI colors, cursor and selection colors. The light palette deliberately darkens Tango accent/white entries because Claude-style previews use those ANSI colors as readable text. [Built-in palettes](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/lib/terminal-themes/defaults.ts#L3-L56)

The selected base palette is composed with optional imported Ghostty/Warp/custom color overrides, background opacity, and cursor opacity, then assigned to `terminal.options.theme`. Pane background and split background are derived from the same composed terminal background. [Theme composition and pane application](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-appearance.ts#L134-L180), [xterm/pane writes](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-appearance.ts#L241-L268), [pane style](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-appearance.ts#L321-L331)

Renderer selection is orthogonal to palette selection. Orca ships xterm `6.1.0-beta.287` and WebGL addon `0.20.0-beta.286`; the same `terminal.options.theme` is used whether xterm is on WebGL or its fallback renderer. [xterm dependencies](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/package.json#L161-L167)

### 2. OSC 10/11 is the main provider startup handshake

Before a PTY is spawned, Orca captures the pane's resolved xterm foreground/background and passes those colors with the spawn request. [Theme capture at connection](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/pty-connection.ts#L3151-L3177)

For a recognized agent TUI, main installs a five-second startup responder. It recognizes OSC 10 foreground and OSC 11 background queries (including the combined `OSC 10;?;?` form), writes `rgb:rrrr/gggg/bbbb` replies directly back to the PTY, handles chunk-split escape sequences, and stops once both slots are answered. [Startup responder scope and lifetime](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/main/ipc/terminal-startup-color-query-replies.ts#L24-L69), [agent gating](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/main/ipc/terminal-startup-color-query-replies.ts#L88-L119), [reply/parser loop](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/main/ipc/terminal-startup-color-query-replies.ts#L121-L196), [wire format](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/shared/terminal-osc-color-reply.ts#L36-L64)

The pre-spawn path is intentional: Orca's comment says Codex probes OSC 10/11 with a 100 ms timeout, while daemon PTYs can emit the query before renderer attachment finishes. [Pre-spawn Codex handling](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/main/ipc/pty.ts#L4028-L4038)

After startup, a visible xterm also has OSC 10/11 parser handlers that answer from its current `terminal.options.theme` and suppress replies during replay. [Visible capability handlers](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-capability-replies.ts#L118-L166)

Hidden PTYs are more elaborate: Orca publishes the resolved 256-color palette and foreground/background from renderer to main so a hidden headless model can answer view-attribute queries without inventing a black default. The official design explicitly says a delivered chunk is answered by the live xterm, while a chunk dropped for a hidden renderer is answered by main, ensuring one responder. [Terminal query authority design](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/docs/reference/terminal-query-authority.md#decision-the-delivery-decision-is-the-reply-decision), [view-attribute bridge](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/docs/reference/terminal-query-authority.md#view-attribute-bridge)

### 3. `COLORFGBG` is not used; truecolor is advertised

A source-wide search at both commits found no `COLORFGBG` read or write. Instead local, daemon, and relay PTYs are spawned with `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Orca`, and a version. [Local PTY environment](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/main/providers/local-pty-provider.ts#L471-L489)

Therefore Orca's light/dark detection path is the terminal protocol (OSC 10/11 and mode 2031), not a static `COLORFGBG` environment hint.

### 4. Provider truecolor output is not rewritten

Orca advertises truecolor and forwards the provider's output string into `writeTerminalOutput`; the normal scheduler passes that same string to xterm's `terminal.write`. [PTY-to-xterm handoff](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/pty-connection.ts#L5225-L5233), [raw output write](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/pty-connection.ts#L5309-L5324), [scheduler write](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler.ts#L822-L855)

The only startup color interception removes the OSC query itself from renderer-bound data after writing the reply; it does not transform SGR color sequences. [Main interception point](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/main/ipc/pty.ts#L2612-L2625)

Orca does set xterm's `minimumContrastRatio` to `4.5`, explicitly to keep white/bright-white body text readable on light themes. This is xterm foreground-contrast protection, not a provider palette or arbitrary truecolor-background rewrite. [Terminal options](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/lib/pane-manager/pane-terminal-options.ts#L49-L56)

### 5. Theme changes update live xterm instances; PTYs are not restarted and provider theme files are not forced

When settings, the system color preference, or effective Option-key mode changes, Orca calls `applyTerminalAppearance` against the existing pane manager. That updates live xterm options, fits panes, resizes connected PTYs if needed, and sends a mode-2031 flip only when subscribed. The effect does not recreate the pane or spawn a replacement PTY. [Live appearance effect](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts#L1913-L1929), [fit/resize/notification](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-appearance.ts#L297-L318)

For a TUI that enabled DEC private mode 2031, Orca sends `CSI ?997;1n` for dark or `CSI ?997;2n` for light. It suppresses duplicate notifications and only pushes on an actual mode flip. [Protocol bytes](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/shared/terminal-color-scheme-protocol.ts#L7-L20), [seed and flip logic](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-mode-2031-replies.ts#L20-L75)

A source-wide search found no Orca path that edits Codex/Claude theme settings or launches those providers with a forced light/dark theme flag. Coordination is via terminal capabilities, not provider configuration mutation.

### 6. WebGL invalidation/repaint is robust, but it is not directly coupled to theme assignment

Orca treats WebGL atlas recovery as a separate reliability subsystem. Because xterm's WebGL atlas is shared by terminals with identical font configuration, a recovery clears atlases for **all** live pane managers, then refreshes all of them; clearing only one could garble other terminals' cached glyph coordinates. [Global reset/refresh rationale](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/lib/pane-manager/pane-manager-registry.ts#L21-L62)

It triggers an immediate reset/refresh burst on tab reveal and image paste, and a single reset/refresh after 200 ms of quiet following risky terminal output. [Recovery triggers](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-webgl-atlas-recovery.ts#L3-L60) A per-pane recovery calls `clearTextureAtlas()` and forces a synchronous full-viewport render through xterm's paused-render guard, falling back to `terminal.refresh`. [Per-pane atlas recovery](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/lib/pane-manager/pane-webgl-renderer.ts#L122-L143)

Codex-style colored blocks get a specific presentation safeguard. `terminalOutputPrefersRenderRefresh` treats any background SGR—including `48;2` truecolor, classic `44`, and bright `104`—as renderer-risk output, while foreground-only truecolor is not enough. [Background-SGR detector](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/lib/pane-manager/terminal-complex-script.ts#L233-L267), [detector tests](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/lib/pane-manager/terminal-complex-script.test.ts#L60-L78) The foreground path says the observed symptom is one where “resize fixes these panes because xterm's buffer is right but in-place redraw cells can remain stale,” then requests a viewport refresh and atlas recovery. [Refresh decision](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/pty-connection.ts#L5163-L5181) Its Codex regression test feeds a `48;2;52;52;52` block and requires both a synchronous full viewport refresh and `scheduleTerminalWebglAtlasRecovery()`. [Codex background-redraw test](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/pty-connection.test.ts#L12307-L12336)

Orca also patches its pinned WebGL addon: atlas clear must use real page content rather than the first page's cursor, clear page glyph statistics, restore active pages, avoid consuming a model-clear notification after the merge retry budget, and clamp texture binding to available texture units. These are explicit defenses against a clear becoming a no-op or a stale model surviving atlas merge/rebuild. [Bundled xterm WebGL patch](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/config/patches/%40xterm__addon-webgl%400.20.0-beta.286.patch#L39-L110)

However, `applyTerminalAppearance` itself does **not** call `clearTextureAtlas()`, `resetAndRefreshAllTerminalWebglAtlases()`, or an unconditional `terminal.refresh()`. It assigns a genuinely changed `terminal.options.theme`, then runs `safeFit`; xterm owns the normal palette-change repaint. The explicit atlas-reset paths are for reveal, output corruption, wake/context recovery, and renderer attachment, not ordinary theme assignment.

Orca deliberately value-gates the theme assignment. Reassigning a value-identical new theme object makes xterm rebuild its palette and discards a TUI's runtime OSC 4/10/11/12 SET mutations. The test pins stable object identity for font-only changes and a fresh assignment only when composed color values change. [Implementation rationale](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-appearance.ts#L205-L228), [assignment guard](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-appearance.ts#L258-L268), [regression tests](https://github.com/stablyai/orca/blob/9924b07bccb8833ac189391ced9750baea059c67/src/renderer/src/components/terminal-pane/terminal-appearance.test.ts#L385-L443)

## Installed app and local-settings corroboration

- `/Applications/Orca.app/Contents/Info.plist` reports both bundle version fields as `1.4.137`; the packaged root `package.json` inside `app.asar` also reports `1.4.137`.
- The packaged JavaScript contains the same default theme names, separate-light-theme default, `minimumContrastRatio: 4.5`, startup color-query plumbing, and mode-2031 sequences as release commit `6013055`.
- This machine's persisted `~/Library/Application Support/orca/orca-data.json` currently has `theme: "dark"`, `terminalGpuAcceleration: "auto"`, `terminalThemeDark: "Ghostty Default Style Dark"`, `terminalUseSeparateLightTheme: true`, and `terminalThemeLight: "Builtin Tango Light"`. These are current user values, used only as corroboration; they are not evidence of product defaults.

## What most likely prevents the light diff/composer mismatch

The following is an inference from the verified mechanisms, not an explicit Orca claim:

```text
Orca resolves dark terminal palette
  -> provider starts and asks OSC 10/11
  -> Orca answers #ffffff / #282c34 before Codex's short timeout
  -> provider selects its dark TUI palette
  -> provider emits dark-compatible explicit diff/composer RGB values
  -> xterm renders them unchanged
```

On a later app-mode flip, a provider that subscribed to mode 2031 receives the new mode and is expected to redraw itself. Orca updates xterm's base/ANSI palette at the same time, but it cannot retroactively reinterpret already-buffered truecolor cells. A resize can appear to “fix everything” because it combines xterm fit/repaint with a PTY resize/SIGWINCH that prompts the provider to redraw the full TUI using its currently detected scheme; Orca's separate atlas/repaint recovery can also clear stale GPU presentation. That explanation fits a screen where old light rows and new dark rows coexist until resize, but it remains an inference unless the provider output stream is captured and shows the actual RGB transition.

## Implications for Tessera

The Orca comparison suggests three distinct safeguards rather than one theme transform:

1. Make startup OSC 10/11 answers available before the provider's timeout, including before renderer mount/reattach races.
2. Support live mode-2031 subscription/flip notifications without restarting the PTY.
3. Treat stale WebGL presentation independently: reset the shared atlas and force a full viewport repaint when mixed old/new visual rows indicate that xterm's buffer and canvas have diverged.

Rewriting all provider truecolor would be a materially different design from Orca and would risk destroying intentional syntax/diff colors. A targeted repaint or provider redraw is closer to Orca's approach.
