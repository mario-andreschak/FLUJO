export const DEFAULT_LOCALE = 'en' as const;
export const LOCALE_STORAGE_KEY = 'flujo.locale';

export const SUPPORTED_LOCALES = [
  { code: 'en', languageTag: 'en', nativeName: 'English', englishName: 'English', direction: 'ltr' },
  { code: 'es', languageTag: 'es', nativeName: 'Español', englishName: 'Spanish', direction: 'ltr' },
  { code: 'de', languageTag: 'de', nativeName: 'Deutsch', englishName: 'German', direction: 'ltr' },
  { code: 'fr', languageTag: 'fr', nativeName: 'Français', englishName: 'French', direction: 'ltr' },
  { code: 'it', languageTag: 'it', nativeName: 'Italiano', englishName: 'Italian', direction: 'ltr' },
  { code: 'pt', languageTag: 'pt', nativeName: 'Português', englishName: 'Portuguese', direction: 'ltr' },
  { code: 'zh-CN', languageTag: 'zh-CN', nativeName: '简体中文', englishName: 'Chinese', direction: 'ltr' },
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]['code'];
export type LocaleInfo = (typeof SUPPORTED_LOCALES)[number];

const localeByCode = new Map<string, LocaleInfo>(
  SUPPORTED_LOCALES.map((locale) => [locale.code.toLowerCase(), locale]),
);

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALES.some((locale) => locale.code === value);
}

/** Resolve browser-style language tags (including regional variants) to a UI locale. */
export function resolveLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;

  const normalized = value.trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';

  const exact = localeByCode.get(normalized);
  if (exact) return exact.code;

  const base = normalized.split('-')[0];
  return localeByCode.get(base)?.code ?? null;
}

export function getLocaleInfo(locale: SupportedLocale): LocaleInfo {
  return localeByCode.get(locale.toLowerCase()) ?? SUPPORTED_LOCALES[0];
}

export function detectBrowserLocale(languages?: readonly string[]): SupportedLocale {
  const candidates = languages ?? (
    typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language]
  );

  for (const candidate of candidates) {
    const locale = resolveLocale(candidate);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}
