import { enUS, ko, zhCN, ja } from 'date-fns/locale';
import type { Locale } from 'date-fns';
import type { Language } from '@/lib/settings/types';

const dateFnsLocaleMap: Record<Language, Locale> = {
  en: enUS,
  ko: ko,
  zh: zhCN,
  ja: ja,
};

const intlLocaleMap: Record<Language, string> = {
  en: 'en-US',
  ko: 'ko-KR',
  zh: 'zh-CN',
  ja: 'ja-JP',
};

export function getDateFnsLocale(language: Language): Locale {
  return dateFnsLocaleMap[language] ?? enUS;
}

export function getIntlLocale(language: Language): string {
  return intlLocaleMap[language] ?? 'en-US';
}
