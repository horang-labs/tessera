# Adversarial Divergence Review

Verdict: pass after API compatibility fix.

Attack scenario 1: one story updates `WorkspaceFilePanel` to poll every two seconds while another story adds a server watcher for `WorkspaceExplorerTab`.

- Covered by AD-1, AD-3, AD-4, and AD-7. Polling is degraded mode only; both surfaces share the same subscription and snapshot contract.

Attack scenario 2: two stories implement different ignore lists, causing files to appear after initial load but disappear after live events.

- Covered by AD-6. Ignore policy is a shared server module used by walk, watcher, and fallback reconcile.

Attack scenario 3: one story pushes full file lists over WebSocket while another expects `/files` to own the response envelope.

- Covered by AD-4 and AD-10. WebSocket sends invalidation/version only; `/files` keeps the existing envelope.

Attack scenario 4: hidden LRU-mounted tabs keep watchers alive forever.

- Covered by AD-1. Subscription lifetime is actual visibility, not React mount state.

No critical or high findings remain.
