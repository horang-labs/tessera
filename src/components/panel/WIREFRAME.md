# Empty Panel Session Target Wireframe

## Goal

Make the destination of **New Session** obvious without requiring users to know
the internal term “Project Worktree”. Reuse the same project name, branch, icon,
and path already shown in the project header.

## Mobile (375px)

### New Session selected

```text
┌─────────────────────────────────────┐
│ UI                                  │
│ ┌──────────────┬──────────────────┐ │
│ │ ◉ Terminal   │ ○ Tessera Chat  │ │
│ └──────────────┴──────────────────┘ │
├─────────────────────────────────────┤
│ OPEN AS                             │
│                                     │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃ ▣  New Session                  ┃ │
│ ┃                                 ┃ │
│ ┃ Creates here                    ┃ │
│ ┃ 📁 content-lab          main    ┃ │
│ ┃ /home/work/Source/content-lab   ┃ │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ ⚿  New Worktree                │ │
│ │ Create a branch and Worktree,   │ │
│ │ then start a session there.     │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ >_ Shell                        │ │
│ │ Open a shell here without an    │ │
│ │ agent.                          │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ SESSION LOCATION                    │
│ ┌─────────────────────────────────┐ │
│ │ 📁 content-lab          main    │ │
│ │ /home/work/Source/content-lab   │ │
│ └─────────────────────────────────┘ │
│                                     │
│ TITLE                               │
│ [ Optional — AI generates if blank]│
├─────────────────────────────────────┤
│ [ Start Session ]                   │
└─────────────────────────────────────┘
```

## Desktop (1024px+)

### New Session selected

```text
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ UI                                                                                         │
│ [ ◉ Terminal (PTY) ✓ | ○ Tessera Chat (GUI) ]                                             │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ OPEN AS                                                                                    │
│                                                                                            │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓ ┌──────────────────────────┐ ┌──────────────────────────┐       │
│ ┃ ▣  New Session           ┃ │ ⚿  New Worktree         │ │ >_ Shell                 │       │
│ ┃                          ┃ │                          │ │                          │       │
│ ┃ Creates here             ┃ │ Create a branch and     │ │ Open a shell here        │       │
│ ┃ 📁 content-lab    main   ┃ │ Worktree, then start a  │ │ without an agent.        │       │
│ ┃ /home/work/Source/       ┃ │ session there.          │ │                          │       │
│ ┃ content-lab              ┃ │                          │ │                          │       │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛ └──────────────────────────┘ └──────────────────────────┘       │
│                                                                                            │
│ ┃ SESSION LOCATION                                                                         │
│ ┃ ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│ ┃ │ 📁  content-lab                                                        [ main ]      │ │
│ ┃ │     /home/work/Source/content-lab                                                   │ │
│ ┃ └──────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┃                                                                                          │
│ ┃ TITLE                                                                                    │
│ ┃ [ Optional — AI generates if blank                                                   ]  │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ A new session will start in /home/work/Source/content-lab.              [ Start Session ] │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

### New Worktree selected

```text
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ OPEN AS                                                                                    │
│                                                                                            │
│ ┌──────────────────────────┐ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓ ┌──────────────────────────┐       │
│ │ ▣  New Session           │ ┃ ⚿  New Worktree         ┃ │ >_ Shell                 │       │
│ │ Creates here             │ ┃                          ┃ │ Open a shell here        │       │
│ │ 📁 content-lab    main   │ ┃ Creates a new branch +  ┃ │ without an agent.        │       │
│ │ /home/work/Source/...    │ ┃ Worktree, then starts   ┃ │                          │       │
│ └──────────────────────────┘ ┃ the session there.       ┃ └──────────────────────────┘       │
│                              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛                                    │
│                                                                                            │
│ ┃ TITLE        [ Optional — AI generates if blank                                      ]  │
│ ┃ BRANCH       [ feature/0813-gr                                                       ]  │
│ ┃ NEW LOCATION 📁 .../content-lab/feature/0813-gr                                         │
│ ┃ START FROM   [ main (current) ▼ ]                                                       │
│ ┃ COLLECTION   [ Other ] [ 고양이소츠 ] [ 경쟁사분석 ] ...                                │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ A branch and Worktree will be created, and the session starts there. [ Create Worktree ]  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Interaction and copy rules

- **New Session** always says `Creates here`; never expose “Project Worktree” in user-facing copy.
- The compact destination inside the card repeats the project header identity:
  `FolderGit2 icon + project name + branch`, followed by the full path.
- Selecting **New Session** shows a read-only `SESSION LOCATION` block before `TITLE`.
- Selecting **New Worktree** labels its computed path `NEW LOCATION`, making the contrast explicit.
- The sticky footer repeats the exact destination for New Session.
- Long paths truncate visually in the card, but the read-only location block exposes the full path and a tooltip/copy affordance.
- The selected card uses the existing accent border/background; destination identity must remain readable without relying on color.
