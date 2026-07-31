import { notFound } from 'next/navigation';
import { AskUserQuestionPreviewClient } from './ask-user-question-preview-client';

export default function AskUserQuestionPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound();
  }

  return <AskUserQuestionPreviewClient />;
}
