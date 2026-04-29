import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
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
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[i18n] Missing key: ${key} (${lngs.join(', ')})`);
      }
    },
  });

export default i18n;
