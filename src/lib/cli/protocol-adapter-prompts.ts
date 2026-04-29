import type { AppServerMessage } from '../ws/message-types';
import logger from '../logger';

interface SendProtocolInteractivePromptArgs {
  sendAppMessage: (userId: string, message: AppServerMessage) => void;
  sessionId: string;
  toolUse: {
    id: string;
    name?: string;
    input?: Record<string, any>;
  };
  userId: string;
}

export function sendProtocolInteractivePrompt({
  sendAppMessage,
  sessionId,
  toolUse,
  userId,
}: SendProtocolInteractivePromptArgs): void {
  if (toolUse.name !== 'AskUserQuestion') {
    return;
  }

  const input = toolUse.input || {};

  if (Array.isArray(input.questions) && input.questions.length > 0) {
    sendAppMessage(userId, {
      type: 'interactive_prompt',
      sessionId,
      promptType: 'ask_user_question',
      data: {
        question: '',
        toolUseId: toolUse.id,
        questions: input.questions.map((question: any) => ({
          ...question,
          options: question.options?.map((option: any) => ({
            ...option,
            markdown: option.preview ?? option.markdown,
          })),
        })),
        metadata: input.metadata,
      },
    });

    logger.info({
      sessionId,
      questionCount: input.questions.length,
    }, 'AskUserQuestion prompt sent (new format)');
    return;
  }

  const promptType = input.options ? 'select' : 'input';
  sendAppMessage(userId, {
    type: 'interactive_prompt',
    sessionId,
    promptType,
    data: {
      question: input.question || '',
      options: Array.isArray(input.options) ? input.options : [],
      toolUseId: toolUse.id,
    },
  });

  logger.info({
    sessionId,
    promptType,
    question: input.question,
  }, 'Interactive prompt detected (legacy)');
}
