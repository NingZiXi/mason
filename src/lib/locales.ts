export const SUPPORTED_LOCALES = ['zh', 'en', 'ja', 'ko'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
export type LocalePreference = Locale | 'system';

export const LOCALE_NAMES: Record<Locale, string> = {
  zh: '简体中文', en: 'English', ja: '日本語', ko: '한국어',
};

/** Use the first supported OS/browser preference, including regional tags. */
export function resolveSystemLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.trim().toLowerCase().split(/[-_]/)[0];
    if (SUPPORTED_LOCALES.includes(base as Locale)) return base as Locale;
  }
  return 'en';
}

export function getSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  return resolveSystemLocale(navigator.languages?.length
    ? navigator.languages : [navigator.language ?? '']);
}
