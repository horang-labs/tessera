'use client';

import { useState, type FormEvent } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModalShell } from '@/components/chat/modal-shell';
import { useI18n } from '@/lib/i18n';

export type FeedbackSource = 'project_strip' | 'cli_error' | 'setup' | 'settings' | 'project_import';

interface FeedbackDialogProps {
  source: FeedbackSource;
  onClose: () => void;
}

export function FeedbackDialog({ source, onClose }: FeedbackDialogProps) {
  const { t } = useI18n();
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedMessage = message.trim();
    const trimmedEmail = email.trim();

    if (!trimmedMessage) {
      setError(t('feedback.required'));
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmedMessage,
          email: trimmedEmail || undefined,
          source,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || t('feedback.sendFailed'));
      }

      setSent(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('feedback.sendFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      title={t('feedback.title')}
      titleId="feedback-dialog-title"
      icon={MessageSquarePlus}
      onClose={onClose}
      overlayTestId="feedback-overlay"
      dialogTestId="feedback-dialog"
      closeTestId="feedback-close"
      footer={
        sent ? (
          <Button type="button" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="feedback-form" disabled={isSubmitting || !message.trim()}>
              {isSubmitting ? t('feedback.sending') : t('feedback.send')}
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <p className="text-sm text-(--text-secondary)">
          {t('feedback.sent')}
        </p>
      ) : (
        <form id="feedback-form" className="space-y-3" onSubmit={handleSubmit}>
          <label className="block">
            <span className="text-xs font-medium text-(--text-secondary)">{t('feedback.messageLabel')}</span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t('feedback.messagePlaceholder')}
              className="mt-1 min-h-28 w-full resize-y rounded-md border border-(--input-border) bg-(--input-bg) px-3 py-2 text-sm text-(--text-primary) outline-none transition-colors placeholder:text-(--text-muted) focus:border-(--accent)"
              maxLength={4000}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-(--text-secondary)">{t('feedback.emailLabel')}</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t('feedback.emailPlaceholder')}
              className="mt-1 w-full rounded-md border border-(--input-border) bg-(--input-bg) px-3 py-2 text-sm text-(--text-primary) outline-none transition-colors placeholder:text-(--text-muted) focus:border-(--accent)"
              maxLength={320}
            />
          </label>
          {error ? (
            <p className="text-xs text-(--error)" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </ModalShell>
  );
}
