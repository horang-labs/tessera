import './config';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import type { Language } from '@/lib/settings/types';

export function useI18n() {
  const { t, i18n: instance } = useTranslation();
  return { t, language: instance.language as Language };
}

export { i18n };
