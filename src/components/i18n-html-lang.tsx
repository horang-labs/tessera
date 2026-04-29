'use client';

import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n';

export function I18nHtmlLang() {
  const { language } = useI18n();

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return null;
}
