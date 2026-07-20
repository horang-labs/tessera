export const OPENCODE_TESSERA_LIFECYCLE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  // 권한 승인 대기 / 질문 대기 → 사용자 입력 대기(input_required). 승인·답변 후
  // PostToolUse로 running 복귀시켜 노란 깜빡점을 해소한다.
  'PermissionRequest',
  'AskUserQuestion',
  'PostToolUse',
] as const;

/**
 * Source for an invocation-local OpenCode plugin. It deliberately has no
 * imports, and OpenCode can load it from OPENCODE_CONFIG_DIR without changing
 * the user's global/project plugin setup.
 */
export function buildOpenCodeHookPluginSource(): string {
  return String.raw`
const asRecord = (value) => value !== null && typeof value === "object" ? value : undefined
const readString = (value) => typeof value === "string" ? value.trim() : ""
const PROMPT_SETTLE_MS = 8
const MAX_SUBMITTED_MESSAGE_IDS = 256

export const TesseraLifecyclePlugin = async ({ directory }) => {
  const hookPort = readString(process.env.TESSERA_HOOK_PORT)
  const paneToken = readString(process.env.TESSERA_PANE_TOKEN)
  const tesseraSessionID = readString(process.env.TESSERA_SESSION_ID)
  let targetSessionID = readString(process.env.TESSERA_OPENCODE_RESUME_ID)
  let startSent = false
  let sessionIdle = false
  let turnHasSubmittedPrompt = false
  // 이번 턴에 세션이 실제로 busy(작업)를 거쳤는지. 완료(Stop) 보고를 프롬프트 캡처
  // 대신 이 신호에 건다 — 프롬프트 주입/타이밍으로 UserPromptSubmit 캡처를 놓쳐도
  // idle 완료를 놓치지 않기 위함(Orca 방식). busy를 안 거친 순수 idle은 억제한다.
  let turnWasActive = false
  // 권한/질문으로 사용자 입력 대기(input_required)를 보낸 상태인지. 승인·답변 뒤 다음
  // busy 전이에서 running으로 복귀시켜 노란 깜빡점을 해소하는 데 쓴다.
  let awaitingUserInput = false
  let postQueue = Promise.resolve()
  let promptFlushTimer
  let idleFinalizeTimer
  const candidateSessionIDs = new Set()
  const userMessageIDs = new Set()
  const submittedMessageIDs = new Set()
  const submittedMessageOrder = []
  const textPartsByMessage = new Map()

  const hookUrl = () =>
    "http://127.0.0.1:" + hookPort + "/__tessera/hook?session=" + encodeURIComponent(tesseraSessionID)

  // WSL2 기본 NAT에서 게스트의 127.0.0.1은 Windows 호스트 리스너에 닿지 않는다.
  // fetch 실패 시 curl.exe(Windows interop 프로세스 — 그쪽 loopback이 곧 호스트)로
  // 재시도한다. hook-command.ts의 이중 curl과 같은 전략.
  const isWslGuest = () => Boolean(readString(process.env.WSL_DISTRO_NAME))
  const postHookViaWindowsCurl = async (payload) => {
    try {
      const { spawn } = await import("node:child_process")
      return await new Promise((resolve) => {
        const child = spawn(
          "/mnt/c/Windows/System32/curl.exe",
          [
            "-sS", "--connect-timeout", "3", "--max-time", "5", "--noproxy", "127.0.0.1",
            "-X", "POST", hookUrl(),
            "-H", "Content-Type: application/json",
            "-H", "X-Tessera-Pane-Token: " + paneToken,
            "--data-binary", "@-",
          ],
          { stdio: ["pipe", "ignore", "ignore"] },
        )
        const timer = setTimeout(() => { try { child.kill() } catch {} resolve(false) }, 6000)
        child.on("error", () => { clearTimeout(timer); resolve(false) })
        child.on("close", (code) => { clearTimeout(timer); resolve(code === 0) })
        child.stdin.on("error", () => {})
        child.stdin.end(JSON.stringify(payload))
      })
    } catch {
      return false
    }
  }

  const postHook = async (payload) => {
    if (!hookPort || !paneToken || !tesseraSessionID) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1000)
    try {
      const response = await fetch(
        hookUrl(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tessera-Pane-Token": paneToken,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      )
      return response.ok
    } catch {
      // Lifecycle observation must never break or delay the OpenCode TUI.
      if (isWslGuest()) return postHookViaWindowsCurl(payload)
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  const enqueue = (payload) => {
    postQueue = postQueue.then(
      async () => {
        if (payload.hook_event_name !== "SessionStart" && !startSent && targetSessionID) {
          startSent = await postHook({
            hook_event_name: "SessionStart",
            session_id: targetSessionID,
          })
        }
        if (payload.hook_event_name === "SessionStart") {
          if (!startSent) startSent = await postHook(payload)
          return
        }
        await postHook(payload)
      },
      async () => {
        await postHook(payload)
      },
    )
    return postQueue
  }

  const sendStart = () => {
    if (startSent || !targetSessionID) return
    enqueue({ hook_event_name: "SessionStart", session_id: targetSessionID })
  }

  const rememberSubmittedMessage = (messageID) => {
    submittedMessageIDs.add(messageID)
    submittedMessageOrder.push(messageID)
    while (submittedMessageOrder.length > MAX_SUBMITTED_MESSAGE_IDS) {
      submittedMessageIDs.delete(submittedMessageOrder.shift())
    }
  }

  const flushUserPrompts = () => {
    for (const messageID of userMessageIDs) {
      if (submittedMessageIDs.has(messageID)) continue
      const parts = textPartsByMessage.get(messageID)
      if (!parts) continue
      const prompt = Array.from(parts.values()).join("\n").trim()
      if (!prompt) continue
      rememberSubmittedMessage(messageID)
      userMessageIDs.delete(messageID)
      textPartsByMessage.delete(messageID)
      turnHasSubmittedPrompt = true
      enqueue({
        hook_event_name: "UserPromptSubmit",
        session_id: targetSessionID,
        prompt,
      })
    }
  }

  const clearPromptFlushTimer = () => {
    if (!promptFlushTimer) return
    clearTimeout(promptFlushTimer)
    promptFlushTimer = undefined
  }

  const clearIdleFinalizeTimer = () => {
    if (!idleFinalizeTimer) return
    clearTimeout(idleFinalizeTimer)
    idleFinalizeTimer = undefined
  }

  const activateTargetSession = (sessionID) => {
    if (!sessionID || sessionID === targetSessionID) {
      sendStart()
      return
    }
    clearPromptFlushTimer()
    clearIdleFinalizeTimer()
    targetSessionID = sessionID
    startSent = false
    sessionIdle = false
    turnHasSubmittedPrompt = false
    turnWasActive = false
    awaitingUserInput = false
    userMessageIDs.clear()
    textPartsByMessage.clear()
    sendStart()
  }

  const finalizeTurn = () => {
    idleFinalizeTimer = undefined
    clearPromptFlushTimer()
    flushUserPrompts()
    for (const messageID of userMessageIDs) textPartsByMessage.delete(messageID)
    userMessageIDs.clear()
    // 완료 보고를 프롬프트 캡처에 묶지 않는다(Orca 방식). UserPromptSubmit을 놓친
    // 턴이라도 세션이 busy를 거쳤으면 idle 완료를 보고한다. busy 없이 온 순수 idle
    // (세션 로드/resume 직후)만 빈 완료로 억제한다.
    if (!turnHasSubmittedPrompt && !turnWasActive) return
    turnHasSubmittedPrompt = false
    turnWasActive = false
    awaitingUserInput = false
    enqueue({ hook_event_name: "Stop", session_id: targetSessionID })
  }

  const scheduleFinalizeTurn = () => {
    clearIdleFinalizeTimer()
    idleFinalizeTimer = setTimeout(finalizeTurn, PROMPT_SETTLE_MS)
  }

  const schedulePromptFlush = () => {
    clearPromptFlushTimer()
    promptFlushTimer = setTimeout(() => {
      promptFlushTimer = undefined
      flushUserPrompts()
      if (sessionIdle) scheduleFinalizeTurn()
    }, PROMPT_SETTLE_MS)
  }

  if (targetSessionID) sendStart()

  return {
    event: async ({ event }) => {
      try {
        const current = asRecord(event)
        const properties = asRecord(current?.properties)
        if (!current || !properties) return

        if (current.type === "session.created") {
          const info = asRecord(properties.info)
          const createdID = readString(info?.id)
          const createdDirectory = readString(info?.directory)
          const parentID = readString(info?.parentID)
          if (!createdID || parentID) return
          if (directory && createdDirectory !== directory) return
          candidateSessionIDs.add(createdID)
          if (targetSessionID) {
            activateTargetSession(createdID)
            return
          }
          return
        }

        if (current.type === "message.updated") {
          const info = asRecord(properties.info)
          const sessionID = readString(info?.sessionID)
          const messageID = readString(info?.id)
          if (!sessionID || !messageID) return
          if (info?.role === "user" && sessionID !== targetSessionID) {
            if (
              (targetSessionID && !candidateSessionIDs.has(sessionID))
              || (!targetSessionID && candidateSessionIDs.size > 0 && !candidateSessionIDs.has(sessionID))
            ) return
            activateTargetSession(sessionID)
          }
          if (sessionID !== targetSessionID) return
          if (info?.role !== "user") {
            userMessageIDs.delete(messageID)
            textPartsByMessage.delete(messageID)
            return
          }
          if (!messageID || submittedMessageIDs.has(messageID)) return
          userMessageIDs.add(messageID)
          if (textPartsByMessage.has(messageID)) schedulePromptFlush()
          if (sessionIdle) scheduleFinalizeTurn()
          return
        }

        if (!targetSessionID) return

        if (current.type === "message.part.updated") {
          const part = asRecord(properties.part)
          if (readString(part?.sessionID) !== targetSessionID || part?.type !== "text") return
          const messageID = readString(part?.messageID)
          const partID = readString(part?.id)
          if (!messageID || !partID || submittedMessageIDs.has(messageID)) return
          if (!userMessageIDs.has(messageID)) return
          if (part?.synthetic === true) {
            textPartsByMessage.get(messageID)?.delete(partID)
            return
          }
          let parts = textPartsByMessage.get(messageID)
          if (!parts) {
            parts = new Map()
            textPartsByMessage.set(messageID, parts)
          }
          parts.set(partID, typeof part?.text === "string" ? part.text : "")
          schedulePromptFlush()
          if (sessionIdle) scheduleFinalizeTurn()
          return
        }

        const sessionID = readString(properties.sessionID)
        if (sessionID !== targetSessionID) return

        // 권한 승인 대기 / 질문 대기 → 사용자 입력 대기(input_required, 노란 깜빡점).
        // Orca 방식: 상태전이(busy/idle)와 별개로 즉시 방출하고 sessionIdle/turnWasActive/
        // finalize 타이머는 건드리지 않는다. 승인·답변 뒤 opencode가 다시 busy로 가면 그때
        // running으로 복귀시켜 대기 표시를 해소한다(아래 busy 처리).
        if (current.type === "permission.asked") {
          const perm = readString(properties.permission)
          const patterns = Array.isArray(properties.patterns)
            ? properties.patterns.filter((p) => typeof p === "string")
            : []
          const detail = patterns.join(", ")
          enqueue({
            hook_event_name: "PermissionRequest",
            session_id: targetSessionID,
            tool_name: perm || "Tool",
            tool_input: detail ? { command: detail } : {},
          })
          awaitingUserInput = true
          return
        }
        if (current.type === "question.asked") {
          enqueue({
            hook_event_name: "AskUserQuestion",
            session_id: targetSessionID,
            question: readString(properties.question)
              || readString(properties.title)
              || readString(properties.text),
          })
          awaitingUserInput = true
          return
        }

        if (current.type === "session.status") {
          const status = asRecord(properties.status)
          const statusType = readString(status?.type) || readString(properties.status)
          if (statusType === "busy") {
            sessionIdle = false
            turnWasActive = true
            clearIdleFinalizeTimer()
            // 권한/질문 대기를 해소하고 다시 작업이 시작되면 running으로 복귀시킨다.
            if (awaitingUserInput) {
              awaitingUserInput = false
              enqueue({ hook_event_name: "PostToolUse", session_id: targetSessionID })
            }
            return
          }
          if (statusType !== "idle") return
        } else if (current.type !== "session.idle") {
          return
        }

        sessionIdle = true
        scheduleFinalizeTurn()
        await new Promise((resolve) => setTimeout(resolve, PROMPT_SETTLE_MS + 2))
        await postQueue
      } catch {
        // Malformed or newly-added OpenCode events are ignored fail-open.
      }
    },
  }
}
`.trimStart();
}
