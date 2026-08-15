# Mobile UI pitfalls — read before touching phone-viewport code

This is the list of mobile-web mistakes we keep repeating in this codebase. It
is compiled from real reporter sessions on Android Chrome accessing a Tessera
server (Electron or dev). "Phone" here means the `max-sm` Tailwind step
(<640px). Every entry names the file(s) that carry the canonical fix; grep for
those patterns instead of inventing new ones.

Desktop is not the reference. Chrome DevTools mobile emulation is not the
reference. A real phone against the actual server is.

---

## 1. Tooltip that never dismisses

**Symptom**: user taps a control with a `Tooltip`, the tip appears and stays on
screen until the page reloads.

**Cause**: `Tooltip` (`src/components/ui/tooltip.tsx`) only listens for
`onMouseEnter` / `onMouseLeave`. A touchscreen synthesises `mouseenter` on tap
but never emits a matching `mouseleave` because there is nothing to leave to.

**Fix**: bail out inside `handleMouseEnter` when
`matchMedia('(hover: none)').matches`. Do not add `touchend`/outside-tap
handlers — a phone user does not benefit from the tip at all, so the cheapest
correct behaviour is not to render it. Same rule for any hover-only affordance.

**Related**: native `title=` attributes on buttons also stick on touch. Prefer
`aria-label` for accessibility and drop `title` unless the desktop hover value
is worth keeping.

---

## 2. Popover snaps shut the moment it opens

**Symptom**: tapping a "+" / "…" / kebab makes a menu flash and immediately
close. Reporter often thinks the button is broken.

**Cause**: an `open` state is flipped in `onClick`, and a `useEffect` registers
`document.addEventListener('mousedown', ..., outside-click)` on that same tick.
A phone tap synthesises `pointerdown → mousedown → mouseup → click` in one
tick. Chrome sometimes routes the synthesised `mousedown` at the body element
rather than the tapped button, so the outside-click watcher runs, sees a target
that is not the trigger, and closes the menu.

**Fix**: defer the listener by one frame with `requestAnimationFrame`:

```ts
const raf = window.requestAnimationFrame(() => {
  document.addEventListener('mousedown', handleMouseDown, true);
});
return () => {
  window.cancelAnimationFrame(raf);
  document.removeEventListener('mousedown', handleMouseDown, true);
};
```

Canonical copies: `CollectionHeaderMenu` in
`src/components/chat/collection-group-sections.tsx`, and
`CollectionQuickCreateSheet` in
`src/components/chat/collection-quick-create-sheet.tsx`. Copy this pattern
whenever you add a new anchored menu / sheet / popover.

**Related — toggle vs open-only**: the trigger's own `onClick` must be a
toggle, not "open". A user's second tap on the same button expects "close". If
you use `stopPropagation()` on the trigger (usually correct) then the outside
watcher can never see that second tap, so open-only means stuck-open on the
second tap. See `handleMoreClick` in `src/components/chat/header.tsx` for the
canonical toggle shape.

---

## 3. Fixed-positioned panel eats the sidebar

**Symptom**: opening the notification bell / dropdown makes the project strip
disappear. Or: the strip is empty from the start on a short phone viewport.

**Cause A — fixed panel overlays the strip**: a 320px anchored dropdown from a
44px strip trigger clamps back inside the viewport and lands on top of the
tiles. The clamp is doing the right thing; the panel is just too wide for a
360px screen.

**Cause B — `flex-1 min-h-0` collapses to zero**: any sibling in a vertical
flex column that is `shrink-0` will keep its height, and a `flex-1 min-h-0`
scroll list next to it shrinks all the way to nothing on a short viewport. The
project tiles vanish while the bell + settings row below them stays visible,
so the reporter reads it as "the whole strip is gone".

**Fix for B**: give the scroll list a phone-sized `min-h` when it has content,
e.g. `min-h-[6.5rem]` for the project strip. See `ProjectStrip` in
`src/components/chat/project-strip.tsx`.

**Fix for A**: keep the anchored panel — but confirm on a real 360px viewport
that its clamped left edge does not overlap the strip. If it does, either the
panel needs a phone-specific width cap or the trigger needs a different anchor
side.

---

## 4. Toast persistence across reload

**Symptom**: reporter dismisses 3 toasts with the X button. Refreshing the
page brings all 3 back.

**Cause**: `useNotificationStore` is in-memory zustand. On reconnect the WS
layer replays the same session events, `addNotification` re-runs with the same
`dedupKey`, and the store is empty so the dedup check passes.

**Fix**: dismissed keys are persisted to `localStorage` under
`tessera:dismissed-notification-keys` (FIFO capped at 500). `addNotification`
short-circuits when the key is in that set. See
`src/stores/notification-store.ts`. If you add a new dismiss action, call
`rememberDismissed(target?.dedupKey)` alongside the state update.

**Related — swipe to dismiss**: the toast card supports horizontal swipe via
framer-motion `drag="x"` (`toast-notification.tsx`). Threshold is 80px offset
or 400 velocity. Do not add a competing `onPan` handler; framer suppresses
`tap` when a drag actually moved, which is what keeps the card from opening
the session on release.

**Related — X button**: the dismiss target on a phone must be at least 44px
_and_ visually obvious. The pattern is a full-height column on the right of
the card (`self-stretch w-9`) with `pointerdown` / `click` stopPropagation, so
tapping X does not bubble to the card and navigate.

---

## 5. Message action bar wraps to its own line on phone

**Symptom**: every assistant message shows a `[Copy] [Translate] [From here]`
row that takes an entire line of vertical space above the actual content.

**Cause**: `MESSAGE_ACTIONS_CLASS` is `opacity-100 pointer-events-auto` on
phone (there is no `hover:` to reveal it, so it is always shown), and each
button has a fixed `w-[4.75rem]` / `w-[6.25rem]` pill width — three of them
never fit next to the timestamp, so `flex-wrap` drops them to a second line.

**Fix**: hide labels on phone with `max-sm:sr-only` on each `<span>`, and let
the button collapse with `sm:w-[4.75rem] max-sm:aspect-square max-sm:px-0`.
Icon-only buttons keep the same accessible names via `sr-only`. Canonical
copies live in both `message-bubble-content.tsx` and `agent-message-group.tsx`
— keep them in step.

---

## 6. Provider avatar column steals horizontal space

**Symptom**: chat messages are indented so far from the left edge that the
first ~50px of every phone row is empty.

**Cause**: `ProviderLogoMark` / `UserAvatar` are `h-8 w-8` (32px), the row has
`gap-3` (12px) and `px-2` (8px). That is 52px of chrome before the message
body. On a 360px screen that is 14% of every row wasted.

**Fix**: shrink on phone.
- Avatars: `h-8 w-8` → `max-sm:h-4 max-sm:w-4`, inner icon
  `h-4 w-4` → `max-sm:h-2.5 max-sm:w-2.5`, `rounded-lg` → `max-sm:rounded-md`.
- Row: `gap-3` → `max-sm:gap-1.5`, `px-2` → `max-sm:px-1`.
- **Also** update `MESSAGE_BODY_OFFSET_CLASS` in
  `src/components/chat/message-layout.ts`: the tool-call / thinking blocks that
  reuse this offset must land exactly under the assistant text, so the
  arithmetic (avatar + gap + row padding) has to be redone whenever any of
  those numbers move. Current phone value: `1.625rem` from 16+6+4.

---

## 7. "Add this folder" wraps to three lines

**Symptom**: primary CTA in `FolderBrowserDialog` breaks into three stacked
words on a phone. Reporter sometimes assumes the button is uninteractive.

**Cause**: a three-across `<Button>` footer (`Cancel`, `Send feedback`,
`Add this folder`). The middle one has both an icon and a label; the primary
label is the longest string of the three. No `whitespace-nowrap`, so the
narrowest button wraps mid-word.

**Fix pattern**: on phone, collapse the secondary CTA to icon-only via
`max-sm:sr-only` on the label and `max-sm:px-2`, add `whitespace-nowrap` to
every button in the row, and drop `gap-3` to `gap-2 sm:gap-3`. See
`folder-browser-dialog.tsx` footer.

Applies to any dialog with 3+ actions in a row on phone.

---

## 8. Modal close button is invisible on phone

**Symptom**: settings dialog opens, reporter cannot find the way out.

**Cause**: the close button sits in the body header, beside a faded feedback
icon, halfway down the modal on phone. The eye looks for the dismiss in the
same row as the title, which on phone is above the body (stacked layout).

**Fix**: render a phone-only close button next to the SETTINGS heading in the
aside, and hide the body-header close on phone with `max-sm:hidden`. See
`SettingsPanel` in `src/components/settings/settings-panel.tsx`. Apply the same
"close lives next to the heading" rule to any modal that reshapes to stacked on
phone.

---

## 9. Tab-list popover has no per-tab status dots

**Symptom**: on desktop each tab in the strip shows a
generating / awaiting / unread / running dot; on phone the strip is replaced by
`TabListControl` and every row is plain text.

**Cause**: `TabListItem` renders a bare button + close, unaware that the same
`ItemStatusIndicator` primitive is used on `TabItem`.

**Fix**: use `useTabStatusIndicator(tab, isActive)` — the shared hook in
`src/components/tab/use-tab-status-indicator.ts`. It returns
`{ statusKind, statusLabel, isProcessing, isAwaitingUser, hasUnread, isRunning,
hasTerminalProcessingSession }` and applies the same priority ladder as
`TabItem`. Feed those into `<ItemStatusIndicator surface="sidebar" size="lg"
placement="inline" />` and the phone list matches the desktop strip 1:1.

Rule: whenever a phone control replaces a desktop control, list the visual
signals the desktop version carried and confirm the replacement carries them
too. Silent loss of status is the failure mode we keep shipping.

---

## 10. Logout button in a browser session that has nothing to log out of

**Symptom**: mobile browser connects to an Electron-hosted Tessera server,
project strip shows a Logout icon that either does nothing useful or logs the
user out of a session they cannot re-enter without the desktop app.

**Cause**: the strip guards Logout on `!isElectron`. That is true from the
browser side, but the *server* is a local Electron app and there is no
meaningful auth to log out of.

**Fix**: the Logout button was removed from `ProjectStrip`. If you ever add it
back, guard on server-side auth mode, not on the *client's* electron detection.

---

## Rules of thumb before you ship

1. **Test on a real phone**, not on emulated viewport. Chrome DevTools
   mobile emulation does not synthesise the touch-derived mouse events that
   cause many of these bugs, and does not run `matchMedia('(hover: none)')`
   the way a real touchscreen does.
2. **Grep for the canonical fix first.** If a similar control already handles
   the pitfall (`Tooltip`, `CollectionHeaderMenu`, `TabListControl`, toast
   dismiss, etc.), copy that pattern rather than inventing a new one.
3. **`max-sm:` is the phone step.** Tailwind's `sm` is 640px, so `max-sm:`
   catches every phone. `md:` and above are the "there is chrome and a mouse"
   world.
4. **Fixed widths of any kind (`w-[4.75rem]`, `w-8`, `min-w-11`) are phone
   traps.** Restate them as `sm:w-[...]` and give the phone `aspect-square`
   or `max-sm:h-N max-sm:w-N` variants.
5. **Whenever you shrink an avatar / icon on phone, update the reused
   offsets that assumed the desktop size** — search for that value across
   `message-layout.ts` and neighbours.
6. **Any state that survives a reload on desktop must survive a reload on
   phone.** Notifications, dismissed banners, expanded groups — all backed by
   `localStorage`, not just the store. Verify by pressing refresh, not by
   inspecting the store.
