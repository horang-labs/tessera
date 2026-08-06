import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEBUG_DIAGNOSTICS } from '@/lib/debug-diagnostics';
import { en } from './en';
import { ko } from './ko';
import { zh } from './zh';
import { ja } from './ja';

const resources = {
  en: { translation: en },
  ko: { translation: ko },
  zh: { translation: zh },
  ja: { translation: ja },
};

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'en',
    fallbackLng: 'en',
    supportedLngs: ['en', 'ko', 'zh', 'ja'],
    interpolation: {
      escapeValue: false,
    },
    missingKeyHandler: (lngs, ns, key) => {
      if (DEBUG_DIAGNOSTICS) {
        console.warn(`[i18n] Missing key: ${key} (${lngs.join(', ')})`);
      }
    },
  });

export default i18n;
