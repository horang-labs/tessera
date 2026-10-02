# One Session automation experience (#529 UX amendment)

Status: **implementation design, not shipped UI or executable proof**. Fixed point: `7e3e1ad527d87932cc38afd68a3d141230022de6`, after Heartbeat/Schedule engine, runtime and UI integration. The [#529 UX clarification](https://github.com/horang-labs/tessera/issues/529#issuecomment-5956325052) and [#534 requirement](https://github.com/horang-labs/tessera/issues/534#issuecomment-5956348770) ask for a coherent experience around user intent, not three independent features. This amendment governs presentation and R3 implementation; [Autorun architecture](session-autorun-architecture.md) governs execution/safety. [Base architecture](session-automation-architecture.md), [acceptance](session-automation-acceptance.md), and [wave](session-automation-wave.md) remain applicable.

## 1. Product decision and integrated starting point

The Session action is **“작업 이어가기 / Continue this work”**: review the existing objective and let a separate supervisor decide the next instruction, completion judgment or need for help. Autorun is the default selected method, never automatically enabled. **“같은 메시지 반복 / Repeat a message”** (Heartbeat) is an explicit alternative within that setup. **“새 세션 예약 / Schedule a Session”** starts from a Worktree and uses the same manager, detail layout, state language and history conventions. Scheduling still creates a new Session; neither continuation method replaces the existing worker. A scheduled Session does not silently acquire Autorun.

At this fixed point, [Header](../../src/components/chat/header.tsx) mounts [AutomationSessionControls](../../src/components/automation/automation-entry.tsx) below the terminal header, and [Session Peek](../../src/components/board/session-peek.tsx) reuses Header with an explicit Session ID. [WorktreeOverview](../../src/components/worktree/worktree-overview.tsx), used by Worktree preview and panel, mounts the schedule entry. The existing [manager](../../src/components/automation/automation-manager.tsx) is a native modal dialog with list/edit/history; [form](../../src/components/automation/automation-form.tsx) exposes all fields and saves disabled. [Store](../../src/stores/automation-store.ts) supports scoped lists, revision checks, idempotent create and paginated runs, but discards mutation results; [hook](../../src/components/automation/use-automation.ts) creates separate polling stores per mount. Rework these seams, not a new dashboard or design system.

The [current guide](../user-guide/session-automations.md) correctly documents today's save-then-enable flow and absence of Autorun. R3 updates it when the new flow ships; this design does not retroactively claim the guide's behavior is implemented. Existing saved rules keep their mode, target, configuration, counts and history. Opening them displays detail; no migration or first-open action enables or converts a rule.

Visual starting evidence: inspected `02-wake-form-defaults.png`, `09-once-explicit-codex-fast.png`, `12-mobile-manager.png`, `06-delivered-and-unknown-history.png` and `05-peek-draining-actions.png` from the [#527 fixture set supplied in the latest comment](https://github.com/horang-labs/tessera/issues/529#issuecomment-5956381687). They show all-fields-first setup, a schedule form whose action falls below the viewport, dense mobile rows with five equal-weight buttons, raw target/reason labels, and Pause reachable while draining. Sections 3–8 replace those specific presentation problems while preserving the last safety affordance. These are fake-transport component screenshots, not a running scheduler or packaged PTY proof.

## 2. Hierarchy, vocabulary and navigation

Use one `AutomationManager` shell with **list → setup or detail → evidence** navigation, a visible Back action and one close control. Detail has **개요 / Overview** and **기록 / History** tabs; configuration is a disclosure in Overview, not a third dashboard. Setup changes only its intent-specific middle section. Do not show three full forms or put every mode in every context. Session scope lists that Session's continuation rules; Worktree scope lists its scheduled rules, matching today's API filters. This is one interaction model, not a promise of a new aggregate query or global automation page.

| Korean product label | English locale | Meaning |
| --- | --- | --- |
| 자동화 | Automation | The saved rule and its lifetime; umbrella label in manager/history |
| 작업 이어가기 · Autorun | Continue this work · Autorun | Adaptive continuation; separate supervisor, same worker |
| 같은 메시지 반복 · Heartbeat | Repeat a message · Heartbeat | The user's fixed text; no goal judgment |
| 새 세션 예약 | Schedule a Session | New worker in the named existing Worktree |
| 진행 중 / 일시정지 / 한도 도달 / 기간 만료 | Active / Paused / Limit reached / Expired | Whole automation state; not a worker result |
| 작업 응답 대기 / 다음 판단 대기 / 분석 중 | Waiting for worker / Waiting to review / Analysing | Phase within an active Autorun rule |
| 이어가기 판단 / 목표 달성 판단 / 사용자 확인 필요 | Continue decision / Goal judged complete / Needs your attention | Attributed supervisor outcome; not host-verified goal completion |
| 지시 전송됨 / 작업 응답 종료 | Instruction sent / Worker turn ended | Delivery receipt and worker observation, independently labelled |
| 멈추고 입력 / 다시 시작 | Pause to type / Resume | Stop new automation and regain safe input / explicitly re-arm |

Use “자동화” rather than “규칙” in primary copy. Display provider product names unchanged. Place worker state beside the existing Session title; place automation state in the automation strip/detail. Never replace task/board status with an automation result. Heartbeat and Schedule can reach their count limit after delivery without judging the user's task complete.

Every view starts with readable **Session title → Project / Worktree branch** or **Worktree name → Project**, and the method. Use existing project/session selectors and materialization, not a full UUID as a heading or link. Identical names gain branch and relative activity time; if still ambiguous, show a short ID in a secondary tooltip. Full IDs are copyable only in optional diagnostics. If a target was removed, retain the rule's readable name and say “세션을 찾을 수 없음 / Session unavailable”; never link to a replacement. Lists must not expose private goal/prompt/packet text from invalidation events.

### A. Entry and compact status (normal panel and Peek)

```text
No automation
  로그인 오류 수정                         Codex · 응답 중
  [작업 이어가기]                                        (A1)

Active automation — same strip in the two Session surfaces
  로그인 오류 수정                         Codex · 응답 종료
  자동화 · 작업 이어가기   진행 중                        (A2)
  다음 판단 01:42 후        [자세히] [멈추고 입력]         (A3)
```

A1 is the single automation entry: inline in Header's action area on desktop, a compact second-line action when space is short. It opens Autorun setup if no current rule exists. With a saved, paused or attention rule it opens that rule's detail instead. The detail Back action reaches the scoped list and other retained rules. Do not duplicate the empty entry in an always-visible second toolbar. Unsupported Session types/providers get a discoverable unavailable explanation, not an apparently working toggle.

A2 replaces the empty action once a current rule exists. Prioritize an ownership-holding rule, then an enabled rule, then the latest attention/paused rule. Never choose an arbitrary first item and operate on a different rule than the ownership snapshot. A3 remains outside disabled composers/PTY inputs, including approvals and recovery. The primary compact action is Pause to type while armed; details contains Edit/Delete and History. At attention/completion show the reason and “확인 / Review”; paused ordinary state offers Resume. No full settings or repeated Delete buttons in the strip. Countdown uses an authoritative due time, never invents progress while busy or offline.

## 3. First setup: confirm intent, do not reconstruct a configuration

### B. Autorun setup

```text
자동화                              로그인 오류 수정  [닫기]
이 작업을 어떻게 이어갈까요?
(●) 작업 이어가기 · Autorun   (○) 같은 메시지 반복       (B1)

목표  · 대화의 사용자 요청에서 확인                      (B2)
“로그인 오류를 고치고 회귀 테스트를 확인해 줘.”
추가 요청: “공개 API는 바꾸지 마.”  [원문 보기] [수정]
완료 기준: 저장한 목표를 기준으로 판단                   (B3)
[조건이나 완료 기준 추가]

감독: <검증된 provider · model · effort · tier> [설정]     (B4)
응답 종료 2분 후 판단 · 지시 최대 10회 · 분석 최대 20회
오늘 23:10까지   [고급 설정 ▸]
이 세션의 자동 입력을 맡깁니다. 언제든 멈추고 입력할 수 있어요.
Tessera가 실행 중인 컴퓨터에서만 동작합니다.
                                         [이어가기 시작] (B5)
```

B1 is a small method selector, not three tabs or separate wizards. Default Autorun can be unavailable with a reason; never silently select or enable Heartbeat as fallback. Switching the **unsaved** method keeps local draft fields without sending them. A saved mode is immutable: changing method requires Pause/drain, a reviewed replacement rule and explicit confirmation (section 6), preserving the Session boundary ledger.

B2 comes from the owner-only preview endpoint, without a model call. Quote/excerpt verified human instructions and corrections in order; “원문 보기 / View source” reveals the full bounded saved objective and source excerpts. Do not present a generated paraphrase as a verified quote. The first screen may show two lines per source and “추가 요청 N개”; expansion makes every saved instruction inspectable before starting. Label provenance **대화에서 확인 / From verified conversation** or **직접 지정 / Set by you**. “수정 / Edit” opens the objective editor inline; explicit override is visibly attributed to the user, not mislabelled as recovered source. No new Session, duplicate worker, or model execution occurs on open/preview/start alone; actual analysis waits for a qualified boundary and due delay.

B3 uses verified user-specified criteria when available; otherwise display the system-labelled default “저장한 목표를 기준으로 판단 / Judge against the saved objective.” Never invent test criteria. Constraints and criteria are optional disclosures, not compulsory blank fields. A missing original objective exposes one required objective field and explains why. Missing latest worker context, unverifiable cutoff or unsafe runtime remains unavailable even after an override. Source conflicts after manual edits require the user to resolve the goal; they cannot be hidden by a successful form validation.

B4 shows a readable resolved selection summary even while advanced fields are collapsed. The supervisor is labelled **감독 / Supervisor**, with help text “대화를 검토해 다음 지시를 정합니다 / Reviews the conversation to choose the next instruction.” The existing worker's saved launch selection is separate, read-only and may be inherited; do not claim it is the live TUI configuration. No worker model change is bundled with enabling automation.

Validated prefill policy (applies without a model call):

1. For an existing rule, preserve its exact selection; an unavailable saved choice is an error requiring explicit correction, never silently replaced.
2. For a new Autorun, use the latest saved explicit supervisor selection for this Session if still proven and available; otherwise use the worker's exact saved selection **only if fully explicit and in the proven supervisor set**. Otherwise select the proven recommended combination returned by preview. If none is available, show unavailable; do not guess a model or turn a nullable worker field into one.
3. The proven set/recommendation comes from **[#530](https://github.com/horang-labs/tessera/issues/530)** and the R0 capability contract, bound to installed provider version and enforced isolation. Intersect it with current normal provider options; the generic model catalog alone proves nothing about supervisor safety. No implementation may advertise every model because two combinations passed. Fast is never an inferred default; a new default uses a proven non-fast combination, or asks for explicit tier choice if only fast is proven. Changing provider/model recalculates valid dependent effort/tier choices and shows the resulting summary before confirmation.
4. For scheduled workers, use the latest explicit launch selection in the current Worktree if supported by the existing detached launch path, otherwise supported provider catalog defaults with explicit supported effort/tier. These are worker capabilities, not supervisor proof. If defaults cannot resolve every required value, expose only the unresolved field(s). Show the complete saved selection before saving. Never copy nullable launch snapshots into a fully specified creation selection.

B5 is the confirmation of this preview, input takeover and the displayed limits. No extra “Are you sure?” dialog or mandatory checkbox. New creation uses the existing idempotent POST with `enabled:true`; the server revalidates provenance, capability, identity and ownership before it succeeds. Do not optimistically claim Active or unlock inputs. Stay in the same shell and replace setup with detail on success. On failure keep the draft and focus the actionable explanation. On response loss, retry only the same creation body/key, then refetch current state; never issue another enable based on a stale replay response. A secondary “나중에 시작 / Save for later” in the footer menu saves disabled; it is not the normal required two-step path.

Advanced setup contains supervisor provider/model/effort/tier, delay, expiry, dispatch/analysis limits and timeout. Prefill the existing contract defaults: 2-minute delay, 10 dispatch attempts, 8-hour expiry, 20 analysis attempts, 120-second analysis timeout. Bounds and retry policy stay in the architecture. Counts include failed/unknown dispatch attempts and every supervisor call/retry; display them as **지시 시도 / Instruction attempts** and **분석 시도 / Analysis attempts**, not completed tasks. Show absolute local expiry with timezone, plus a short summary when collapsed. Separate supervisor calls consume the user's existing provider allowance; do not promise a cost, new subscription or quota bypass. Expired defaults during a long-open form require refreshed validation, not silent extension.

### C. Heartbeat variation in the same setup

Replacing B2–B3, show one field **반복할 메시지 / Message to repeat**, with a neutral example placeholder, never an active default instruction. B4 becomes “기존 세션의 시작 설정 유지 / Keep the Session's saved launch settings”; it has no supervisor selector or analysis budget. Keep delay/dispatch limit/expiry in the same Advanced disclosure, the takeover text and the same start/save-for-later actions. State the distinction once: “작업 완료 여부를 판단하지 않고 같은 메시지를 보냅니다 / Sends your fixed message without judging completion.” No second name/title field: prefill the automation name from Session title and method, editable under Advanced.

## 4. Active detail, decisions and shared history

### D. One detail layout

```text
[자동화 목록 ‹] 로그인 오류 수정 · 작업 이어가기 [⋯] [닫기]
진행 중 · 분석 중                          [멈추고 입력]   (D1)
사용한 한도: 지시 2/10 · 분석 3/20     오늘 23:10 종료
[개요] [기록]
목표: 로그인 오류 수정과 회귀 테스트 확인  [목표·설정 ▸]

최근 흐름                                                   (D2)
14:08  작업 응답 종료  →  14:10 분석 시작
14:10  이어가기 판단: “수정은 됐지만 검증 결과가 없습니다.”
       지시: “관련 회귀 테스트를 실행하고 결과를 확인…”
       전송됨 · 작업 응답 대기               [근거 보기]
14:04  이전 판단                             [기록 더 보기]
```

D1 combines whole-rule state with a subordinate current phase; it is not a second worker status badge. Show remaining lifetime counts and expiry, not a percentage of the goal or a fabricated ETA. During same-selection bounded retry: “제공자 일시 오류 · 42초 후 다시 분석 / Provider temporarily unavailable · Retry in 42s”, attempt number and Pause remain visible. Exhaustion/auth/invalid-output/timeout/uncertainty follow architecture policy, never a UI “try another model” fallback. Do not notify/toast every phase change.

D2 is a newest-first timeline, with timestamps plus explicit labels; related worker boundary → analysis → outcome → delivery appear within **one decision card** in chronological order. Analysis attempts/retries expand under that card, not duplicate user-visible decisions. `continue` shows the proposal separately from “전송 대기 / Awaiting delivery”, “전송됨 / Sent”, “취소됨 / Cancelled”, “전송 여부 확인 필요 / Delivery uncertain”. A valid proposal is not a send. `complete` and `needs-user` have no fake delivery row. A worker turn ending is neutral evidence, never a success checkmark.

History is the same component for all methods: timestamp, meaningful event/outcome, one-line reason, linked Session name, and optional details. Autorun adds decision groups; Heartbeat uses delivery cards; Schedule uses creation/delivery cards and resulting Session links. Display effective **saved/requested** selection as applicable in a disclosure per card; do not repeat raw model/effort/IDs on every compact row. Show coalesced/skipped/deferred/cancelled/failed occurrences explicitly, including why and whether another occurrence is scheduled. Load more preserves loaded pages, selection and scroll across refresh; deduplicate by durable IDs, with a “새 기록 N개 / N new entries” affordance instead of jumping while the user reads older entries. Overview shows only the latest few entries; History has the full paginated list, not another full control form.

“근거 보기 / View evidence” opens an in-shell detail with attributed rationale, each criterion and its cited excerpts, proposed instruction, and **전체 / 일부 발췌 / 압축됨 / 불완전** (Full / Bounded excerpts / Compacted / Incomplete) coverage. Show omitted ranges/tool truncation near the conclusion. Render all source/proposal content as untrusted text using existing safe rendering; citations are references, not commands or authorization. Link “작업 세션 보기 / View worker Session” through existing materialization/project navigation. The current transcript UI does not promise a stable record-ID anchor: show the exact cited excerpt here and open the Session without claiming it scrolled to that record. No new transcript navigation API is required for this release.

Scoped list rows contain rule name, method, whole state, next due/attention reason, and counts as secondary text. Clicking opens detail; an active row may expose Pause, with Edit/Delete in overflow. Group **확인 필요 / Needs attention**, **진행 중 / Active**, then **일시정지·종료 / Paused and ended**; newest update first within each group. “삭제된 항목 포함 / Include deleted” is a list filter, not a primary setup control. Loading and background refresh do not erase an already loaded list. Retain list/detail/history state when closing and reopening that context in the same app lifetime; no cross-owner UI cache.

## 5. Attention, completion and honest states

### E. An attributed outcome with a next action

```text
로그인 오류 수정 · 작업 이어가기
목표 달성으로 판단 · 자동화 일시정지                       (E1)
감독 <provider/model>의 판단입니다. 작업 상태는 바뀌지 않았습니다.
“저장한 목표가 충족된 것으로 보입니다.”
근거: 회귀 테스트 결과…  컨텍스트: 일부 발췌              [근거 보기]
[작업 세션 보기]                                   [⋯ 다시 시작]

사용자 확인 필요 · 자동화 일시정지                       (E2)
“데이터 삭제 승인 여부는 사용자가 결정해야 합니다.”
[작업 세션 보기]     입력 반환 중…                         (E3)
```

E1 never archives a Session, closes a Task, changes Kanban completion, or asserts tests ran beyond evidence. Review evidence is the primary next action; Resume is secondary and goes through a fresh preview. E2 explains the concrete missing decision/evidence, with the relevant Session link. Native approvals/questions stay in the native worker UI; never add an “Approve and continue” automation button. E3 is independent input ownership: a final judgment may be persisted while an older writer is still draining. Only authoritative `human` ownership permits typing.

| Situation | Display and next action; no hidden automatic transition |
| --- | --- |
| Empty Session / Worktree list | “이 작업을 이어가도록 맡겨 보세요 / Continue this work” or “이 Worktree에 새 세션을 예약하세요 / Schedule a Session here”; one contextual CTA and local execution note. Empty History says no attempts yet and shows the next trigger, not a failure. |
| Initial preview/list loading | In-shell skeleton and “대화와 실행 환경 확인 중 / Checking conversation and runtime”; disable only start-dependent actions. Close and Pause on an existing rule remain reachable. No model activity spinner. |
| Unavailable provider/version or no proven supervisor combination | Explain the unavailable capability; “다시 확인 / Check again” repeats metadata/context inspection without a model call. Offer explicit Heartbeat selection or manual work when supported; never call that Autorun. |
| Objective missing vs latest context missing | First: editable objective with source warning. Second: “최근 작업 내용을 확인할 수 없어 시작할 수 없습니다 / Latest worker context unavailable”; View Session and Check again. An objective override cannot cure missing context. |
| Native approval, dirty unsent PTY text, unknown lifecycle, exited/missing target | Name the reason in human terms; go to the same Session to resolve it manually. Do not submit/clear text, restart a worker or answer approvals from the automation UI. A known running turn can arm and wait; idle time alone cannot. |
| Paused ordinarily | “일시정지 · 입력 가능 / Paused · You can type” only with authoritative human ownership; Resume with preserved counts and a fresh preview. |
| Draining (including 202) | “멈추는 중 · 진행 중인 입력을 정리하고 있습니다 / Pausing · Finishing the current input”; keep output visible and drafts intact. Disable Resume/Edit while held; Delete remains reachable and does not bypass the hold. No spinner timeout that unlocks input. |
| Delivery unknown / recovery required | “전송 여부를 확인해 주세요 / Check whether the instruction was sent”; View Session, then “확인 후 직접 처리 / Acknowledge and handle manually” confirmation after inspection. State that this does not resend or assert delivery failed. Server quiescence controls when acknowledgement is allowed; counts/history remain, rule stays disabled/deleted. |
| Rule exhausted or expired | Show which finite limit ended it; “한도·기간 검토 / Review limits and expiry” opens edit. No one-click reset or automatic duplicate rule. Increasing limits is explicit; lifetime counters stay. |
| Capacity retry vs final analysis failure | For policy-approved retry show next attempt/count and Pause. For final failure show readable cause and “설정 확인 / Review settings” or View Session. Resume requires current capability and fresh boundary; never rerun an old decision. |
| Revision conflict / save failure | Preserve local changes, show “다른 화면에서 변경되었습니다 / Changed elsewhere”; Refresh and review differences. Never automatically re-enable or overwrite the newer revision. Network retry must retain create idempotency; list/detail refresh is read-only. |
| Disconnected/offline backend or stale ownership | Keep last known status visibly marked stale: “연결 끊김 · 현재 상태 확인 불가 / Disconnected · Current state unknown”. Pause attempt cannot be reported successful without a response; show Retry connection. Inputs stay governed by the existing ownership gate, not cached rule state. |
| Backend restart / missed schedule | Autorun interrupted: explicit Resume and fresh boundary. Schedule: show the recorded coalesced/skipped outcome and next due; no catch-up storm. Sleeping/closed host cannot run local automation; closing only the viewer does not necessarily stop the backend. |
| Deleted or inaccessible target/rule | Read-only retained history for authorized deleted rules; no Restore. Forbidden/missing data gets a neutral unavailable message without another owner's details; return to the scoped list. |

Map machine reasons to these actionable translations in `automation-error`; raw protocol/DB codes live only under **문제 해결 정보 / Diagnostics**. Keep provider errors sanitized. Do not claim a disconnected backend is merely “paused” or that browser presence determines execution.

Use the existing notification center, not a new inbox. Publish one attention item for a persisted complete/needs-user outcome or a new paused/error reason; routine continuation, analysis and retry stay in detail. Active Sessions still get the item and visible strip update, with existing sound preferences, no repeated toast. Dedup by persisted identity/outcome across WS replay, list/detail reconciliation and dismissals. Persisted rule detail recovers the latest undismissed attention on reconnect; do not scan and resurrect the entire historical decision feed. Marking read/dismissing a notification never resumes a rule.

Current notification-store behavior removes all other notifications for the same Session; R3 must narrow that replacement to the **same notification family** so Autorun attention and a native permission request can coexist. Current WS handlers suppress notification creation for the active Session and call a worker turn “completed”; add a distinct Autorun path that is not suppressed. While automation owns the Session, routine worker-turn completion belongs in the timeline rather than generating a misleading task-success notification. Preserve native approval notifications and unrelated notification behavior. Notification click loads the owner's rule/decision detail in the common manager; “View worker Session” reuses the existing notification navigation convention (actual rendered board/Peek preference, otherwise existing tab/preview), with no forced replacement tab or desktop-only assumption.

## 6. Takeover, edits and resume

Pause to type is **one click**, from strip or detail, with no confirmation. It stops new automation, not the running worker. Retain the local ChatView draft unchanged; do not clear, submit, move it into the rule prompt or copy it into the PTY. On authoritative human ownership, announce “자동화를 멈췄습니다. 직접 입력할 수 있어요 / Automation paused. You can type.” A strip-origin action may focus its own visible composer; a dialog-origin action stays in the dialog with “세션으로 돌아가기 / Back to Session”, then restores focus safely. Never steal focus into a hidden panel/other Session.

Resume opens the same compact goal/selection/limit preview, highlighting new verified human instructions since the last goal revision. Existing unchanged values are already filled; no full setup repeat. Show remaining counts/expiry and “새 작업 응답이 끝난 뒤 판단합니다 / Reviews after a fresh worker turn” when a prior boundary was consumed. The single **다시 시작 / Resume** button confirms takeover; merely opening preview does not re-arm. If no fresh turn exists, re-arming can wait but must not schedule the old boundary or a cached proposal. Completed/needs-user cases follow the same rule, with the last judgment still visible. Selection/capability drift and ambiguous goals block until corrected.

Edit lives in detail overflow. If active, offer **멈추고 수정 / Pause and edit**, then wait for human ownership/no unresolved run before exposing editable fields. Saving an edit preserves counts and leaves the rule disabled, as today's API requires; present “저장됨 · 다시 시작 필요 / Saved · Resume to continue” with the compact Resume preview. Do not mask two mutations as an atomic save-and-resume. Target is read-only. Switching Heartbeat↔Autorun on a saved rule is labelled “방식 바꾸기 / Change method”: pause/drain, preview the new method, then a specific confirmation “기존 자동화를 삭제하고 새 방식으로 시작 / Replace this automation and start”. Only after confirmation soft-delete the old rule and create the replacement; preserve its history and Session boundary ledger. If creation fails, show the deleted old record and retained new draft, with explicit retry; never silently restore/enable the old rule. Explain new-rule limits before confirming; this is not an automatic budget-reset path.

Delete has a short contextual confirmation because it removes the saved rule from the normal list: “자동화를 삭제할까요? 세션과 기록은 남고 실행 중인 작업은 종료하지 않습니다 / Delete this automation? Session and history remain; the worker will not be stopped.” The action remains accessible during analysis, errors, approvals and draining, but never promises instant input release. Close, Back, opening Advanced, ordinary Pause and read-only refresh have no confirmation. Keep setup drafts in memory by context when navigating Back/Close; changing targets never carries private goal text to a different Session by accident.

## 7. Worktree scheduling in the same manager

### F. Contextual schedule setup and resulting history

```text
Worktree: feature/login  ·  Tessera
[새 세션 예약]       자동화 2개 · 다음 오늘 18:00            (F1)

자동화                         feature/login  [닫기]
새 세션 예약
작업  [오늘 변경사항을 검토하고 결과를 정리해 줘…]           (F2)
이름  [변경사항 검토]    (작업 첫 줄에서 제안, 수정 가능)
시간  (●) 한 번  (○) 일정 간격
      [날짜] [시간]  Asia/Seoul (UTC+09:00)
      오늘 18:00에 세션 1개 생성                           (F3)
실행: <provider · model · effort · tier> [고급 설정 ▸]
Tessera가 실행 중인 컴퓨터에서만 동작합니다.     [예약 시작]

Same detail / History after execution
오늘 18:00  세션 생성 · 초기 지시 전송됨  [변경사항 검토 ↗]
            작업 응답 종료 (목표 달성 판단 아님)             (F4)
```

F1 opens the same manager: initial setup when empty, contextual list otherwise; row opens detail. The existing Worktree is fixed/readable, not a UUID field or a second Project picker. Link to its overview for orientation. A missing/live-incompatible Worktree cannot be silently recreated. No schedule switch inside Session takeover setup.

F2 needs the work prompt, editable Session title, and time. A deterministic normalized first-line title suggestion may reduce typing, within the existing 120-character limit; no title model call. Automation name defaults to that title, editable under Advanced. F3 defaults the **kind** to Once, but requires an explicitly chosen future time; convenient “1시간 후 / In one hour” is a user choice resolving to a displayed absolute instant. Interval reveals only start date/time and “매 N분/시간 / Every N minutes/hours”, deliberately chosen within existing bounds. It is fixed elapsed time, not “daily at 09:00”, cron or a timezone calendar. Explain daylight-saving implications beside interval help when relevant. Show next due in local timezone/offset; stored UTC instant is available in details, not a second compulsory input.

Advanced reuses selection/limits/expiry controls. Once fixes the attempt limit at one, with 30-day default expiry; interval starts with 100 attempts and 30-day expiry. If the chosen start exceeds expiry, expose the expiry field and require correction within the 90-day bound. Preview refreshes against server validation; no scheduled work is created merely by opening. “예약 시작 / Start schedule” is the enabled idempotent create and its clear confirmation; Save for later is the same secondary option as Session setup.

The same detail has Pause (not Pause to type because there is no Session input ownership for the schedule rule), Resume, Edit and Delete. Explain overlap near the next-run line when deferred: waiting on a Session created by this automation/Worktree; unrelated manual Sessions do not become global blockers. For interval restart, older missed slots are coalesced and at most the latest eligible slot is considered; overdue Once follows the existing bounded window and records a skip if too late. The backend owns exact decisions; UI displays them and never creates its own timer-driven launch.

F4 links the actual resulting Session; creation/initial delivery and subsequent worker observation remain separate. Opening it uses ordinary Session/Project navigation, keeps the schedule history paginated state for return from its Worktree, and does not start Autorun. No reverse-lookup API or new “all Worktree automations including every worker” dashboard is required. The user can explicitly choose Continue this work in that Session later.

## 8. Narrow layouts, keyboard and surface continuity

### G. Mobile/Peek geometry, same information hierarchy

```text
로그인 오류 수정                       [닫기]
자동화 · 진행 중
다음 판단 대기        [멈추고 입력]                       (G1)
---------------------------------------------------------
자동화 detail (modal sheet, one scroll region)
[‹ 목록] 작업 이어가기                   [⋯] [닫기]
일시정지 · 사용자 확인 필요
[개요] [기록]
Reason / evidence cards, single column                    (G2)
...
[작업 세션 보기]              safe-area bottom footer      (G3)
```

Product strings use the selected locale consistently. On narrow screens wrap the title/context and secondary counts, never the whole page horizontally. Keep the primary action at least 44px high and reachable without scrolling long evidence; compact status may take two lines. No hover-only reasons, color-only states or icon-only destructive actions. Do not collapse Pause into overflow. In history, fold configuration/evidence until requested; large raw transcripts never fill the initial viewport.

Keep the existing manager's native `<dialog>`/portal and modal focus behavior. Use existing spacing, `--chat-bg`, `--sidebar-bg`, `--divider`, text/accent tokens, buttons and tab/disclosure patterns. Desktop uses the current bounded width (up to 42rem); narrow layout adopts the safe-area/full-width geometry of [PhoneBottomSheet](../../src/components/ui/phone-bottom-sheet.tsx) **without nesting a second modal** or assuming that component supplies a focus trap. One scroll region, `dvh` sizing, keyboard-safe footer and visible Close/Back. Announce meaningful state transitions politely; don't announce every countdown tick. Errors focus their message/field, not the terminal.

Normal panel and Kanban Peek share the exact control, scope store and manager. Every action captures its explicit Session ID; no `activeSession` singleton routing. The manager stops portal key/click propagation to Peek, so Escape closes only the top automation/evidence view and never reaches the PTY or closes the underlying Worktree/Session preview; Tab remains within the top modal. Restore focus to the actual invoking control if still mounted, otherwise a visible control in the same surface. Existing Session Peek has its own Tab trap and Worktree Peek a window Escape listener: R3 must fixture-test this nesting and narrowly adjust the preview listener only if required. Closing Peek/manager or switching chat/PTY must not disable automation or erase drafts. Mobile's rendered list layout must not follow a desktop board preference into an invisible Peek.

## 9. Implementation ownership and concrete contract reconciliation

This is an amendment to **R3 / [#534](https://github.com/horang-labs/tessera/issues/534)**, which must implement these continuous flows before combined **[#528](https://github.com/horang-labs/tessera/issues/528)**. It does not authorize edits by this design ticket or transfer R1/R2 implementation into UI. Use existing development Sessions with GPT-6.1-Sol high for product implementation where practical; this design and both independent reviews use Astra xhigh.

| Owner | Exact files / scope and reason |
| --- | --- |
| R3: existing automation UI | `src/components/automation/{automation-entry,automation-manager,automation-form,automation-history,ownership-actions,automation-error}.tsx` and `src/components/automation/use-automation.ts`; split focused view components only under this same directory if needed. One context shell, intent-specific setup sections, shared state/reason presentation and timeline. No parallel Autorun dashboard. |
| R3: store and Header | `src/stores/automation-store.ts`, `src/components/chat/header.tsx`. Keep mutation `ControlResult` and HTTP 200/202 distinct from success booleans, retain idempotency/revision behavior, share keyed per-owner/scope read/invalidation state across mounted normal/Peek consumers, last-wins refresh, history cursors and UI draft state. Release subscriptions on unmount; this cache is not a second scheduler and cannot grant ownership. |
| R3: narrow entry/surface additions | `src/components/worktree/worktree-overview.tsx`; only if nesting evidence demands it, `src/components/worktree/worktree-peek.tsx` and `src/components/board/session-peek.tsx` for top-dialog Escape/focus coordination. Keep their task/branch/terminal behavior intact. Reuse Session navigation/materialization hooks without editing their implementation. |
| R3: attention, text and guide | `src/lib/ws/client-message-handlers.ts`, `src/stores/notification-store.ts`, `src/components/notifications/**`, `src/lib/i18n/automation.ts` and existing notification locale modules as needed; `docs/user-guide/session-automations.md`. Distinct active-Session attention, family dedup, existing navigation, truthful current guide. |
| R3: validation and static telemetry | `tests/automation-ui.test.tsx`, `tests/automation-store.test.ts` and narrowly named new Autorun UI/store tests; relevant notification/Peek fixtures. Existing `src/lib/telemetry/ui-click.ts` static control/surface registry additions only, no transport change. All actionable controls need safe static metadata; no prompt, goal, path, model-returned text or IDs in click telemetry. Compare baseline controls exactly. |
| R0 / #531 → R1 / #532 and R2 / #533 | Freeze only the concrete data gaps below. R1 supplies verified provenance/capability; R2 supplies owner-authorized preview/detail and persisted attention. No R3 parsing native transcripts, provider argv, DB migration or runtime input fixes. Route missing contracts through orchestrator with fixtures. |

Existing composer/terminal/draft files, frozen ownership modes, worker identity and writer fencing stay outside R3. Any actual defect there goes to its owner; do not emulate an unlock in UI.

Concrete freeze requirements, derived from the integrated seams (not new endpoints beyond the architecture):

1. **Preview readiness and validated default**: the proposed preview must expose verified source excerpts/provenance, criterion origin, current-context readiness/reason and the **#530-proven supervisor combinations plus a recommended explicit non-fast selection when available**. Bind capability to provider/version/isolation proof and revalidate on save/arm. Generic `useProviderSessionOptions` cannot supply this truth. R0 freezes shape/fixtures; R1 owns capability evidence; R2 composes preview. No inference from a client-populated list. All fields here are implementation requirements, not claims about current S0 exports.
2. **Attention without a decision**: a context/capability failure can pause before a supervisor decision exists. The architecture's proposed attention event requires `decisionId`, which cannot identify that case. R0 must allow a typed non-decision attention identity (rule ID + revision + persisted reason), with `decisionId` absent/null for that branch; R2 persists/exposes it in owner detail and emits text-free invalidation. Decision outcomes retain `autorun:<decisionId>:<outcome>` dedup; rule-only attention uses `autorun:<automationId>:<revision>:<reason>`. This is the sole event-shape gap identified here; do not fabricate a decision/run just to notify. R3 maps both identities to one detail view and preserves existing native notifications.
3. **No further API expansion for UI conveniences**: retain create with `enabled:true`, disabled edit + explicit re-arm, existing input-ownership reconciliation, scoped lists and run/decision pagination. Names come from existing Session/Worktree state. Source excerpts live in owner decision detail; unsupported deep links degrade to View Session. Retry deadlines/attempts and linked run status use already-required decision/detail data. If R0 fixtures omit any of these, report the exact missing field instead of inventing a local scheduler/status.

## 10. Requirement-to-flow coverage and future proof

| Continuous user story / requirement | Design reference | Implementation and combined QA assertion |
| --- | --- | --- |
| Leave an existing task running without rebuilding its objective | A → B → D; preview/default policy | Verified source + optional edit, one confirmation, no model call on open/enable, same worker, proven supervisor selection only. |
| Use fixed text instead, without learning another manager | B1 → C → D/history | Shared shell and bounds; no supervisor call or goal-complete claim; changing a saved mode drains and confirms. |
| Follow progress and decide whether a result is credible | D → E | Worker turn, analysis, proposal, delivery and attributed completion distinct; coverage/excerpts available, paginated history stable. |
| Take over, type a correction, then delegate again | A3 → section 6 → B/D | One-click Pause, authoritative unlock/drain, draft preserved; new human changes previewed, counts retained, no old-boundary replay. |
| Resolve approval, missing context, transient/final failure or ambiguous delivery | Section 5 state matrix → E/section 6 | Human next action, bounded policy retry, no native auto-approval, fallback/model switch, resend or premature unlock. |
| Schedule a new Session and inspect what happened | F → shared list/detail/history → worker Session | Once/interval, explicit selection/time, local backend limitation, overlap/missed-run reasons; no automatic Autorun or success claim. |
| Notice attention even with worker visible | A/E + notification rules | One persisted attention per identity across reconnect, active Session visible; approval and Autorun items coexist. |
| Use normal panel, Kanban Peek and mobile consistently | A/D/G + ownership table | Same Session target, keyboard/focus isolation, Pause reachable, safe-area/footer, draft retention, HTTP-safe IDs and no hidden desktop Peek. |

R3 supplies focused UI/store fixtures for each transition, including slow preview, unsupported proof/version, response loss/conflict, pause during analysis/drain, recover/deleted records and notification dedup. Fixture screenshots show layout, not live PTY/supervisor proof. The single combined #528 gate uses real packaged Windows backend + WSL CLI, both providers and normal/Peek surfaces; includes setup → continue → pause/manual correction → resume → attributed completion/attention and Worktree schedule → actual Session navigation. Use isolated profile, manifest-owned cleanup, ordered screenshots copied to Windows Downloads, no video; follow the architecture's cross-boundary procedures. No cloud, cron, new credentials, generic platform or native approval automation is added.

This prose change is validated by reference/anchor, requirement-to-flow, scope and independent Standards/Spec review. It has no executable TDD seam; typecheck/lint/test/build/E2E would not prove the design. No executable or screenshot evidence is claimed by #529. #530 proof, #531 contract freeze, #532/#533/#534 implementation and #528 combined verification remain explicit dependencies.
