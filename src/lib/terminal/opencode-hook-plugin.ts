export const OPENCODE_TESSERA_LIFECYCLE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
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
  let postQueue = Promise.resolve()
  let promptFlushTimer
  let idleFinalizeTimer
  const candidateSessionIDs = new Set()
  const userMessageIDs = new Set()
  const submittedMessageIDs = new Set()
  const submittedMessageOrder = []
  const textPartsByMessage = new Map()

  const postHook = async (payload) => {
    if (!hookPort || !paneToken || !tesseraSessionID) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1000)
    try {
      const response = await fetch(
        "http://127.0.0.1:" + hookPort + "/__tessera/hook?session=" + encodeURIComponent(tesseraSessionID),
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
    if (!turnHasSubmittedPrompt) return
    turnHasSubmittedPrompt = false
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

        if (current.type === "session.status") {
          const status = asRecord(properties.status)
          const statusType = readString(status?.type) || readString(properties.status)
          if (statusType === "busy") {
            sessionIdle = false
            clearIdleFinalizeTimer()
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
