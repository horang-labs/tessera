'use client';

import { useChatStore } from '@/stores/chat-store';
import { PermissionFloatingBar } from './permission-floating-bar';
import { AskUserQuestionFloatingPanel } from './ask-user-question-floating-panel';
import { PlanApprovalFloatingPanel } from './plan-approval-floating-panel';

interface InteractivePromptOverlayProps {
  sessionId: string;
}

export function InteractivePromptOverlay({ sessionId }: InteractivePromptOverlayProps) {
  const prompt = useChatStore((s) => s.activeInteractivePrompt.get(sessionId));

  if (!prompt) return null;

  return (
    <div className="px-4 pb-2 animate-slide-up">
      {prompt.promptType === 'permission_request' && prompt.toolName && (
        <PermissionFloatingBar
          toolName={prompt.toolName}
          toolInput={prompt.toolInput || {}}
          toolUseId={prompt.toolUseId}
          sessionId={prompt.sessionId}
          decisionReason={prompt.decisionReason}
          agentId={prompt.agentId}
        />
      )}

      {prompt.promptType === 'plan_approval' && (
        <PlanApprovalFloatingPanel
          plan={prompt.plan}
          allowedPrompts={prompt.allowedPrompts}
          planFilePath={prompt.planFilePath}
          toolUseId={prompt.toolUseId}
          sessionId={prompt.sessionId}
        />
      )}

      {prompt.promptType === 'ask_user_question' && prompt.questions && (
        <AskUserQuestionFloatingPanel
          questions={prompt.questions}
          toolUseId={prompt.toolUseId}
          sessionId={prompt.sessionId}
          metadata={prompt.metadata}
        />
      )}

      {/* Legacy select/input prompts — fallback (should be rare) */}
      {(prompt.promptType === 'select' || prompt.promptType === 'input') && (
        <div className="rounded-lg border border-(--divider) bg-(--chat-bg) shadow-lg p-4">
          <p className="text-sm text-(--text-primary)">{prompt.question}</p>
          {prompt.options && (
            <div className="mt-2 space-y-1">
              {prompt.options.map((opt, idx) => (
                <div key={idx} className="text-xs text-(--text-secondary)">{opt}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
