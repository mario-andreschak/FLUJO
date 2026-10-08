import {
  catalogs,
  type PluralCategory,
  type PluralTranslationKey,
  type TranslationKey,
} from './messages';
import { DEFAULT_LOCALE, getLocaleInfo, type SupportedLocale } from './locales';

export type TranslationValues = Record<string, string | number>;
export type Translator = (key: TranslationKey, values?: TranslationValues) => string;

export function translate(
  locale: SupportedLocale,
  key: TranslationKey,
  values: TranslationValues = {},
): string {
  const template = catalogs[locale]?.[key] ?? catalogs[DEFAULT_LOCALE][key] ?? key;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function translatePlural(
  locale: SupportedLocale,
  key: PluralTranslationKey,
  count: number,
  values: TranslationValues = {},
): string {
  const category = new Intl.PluralRules(getLocaleInfo(locale).languageTag).select(count) as PluralCategory;
  const catalog = catalogs[locale];
  const localizedKey = `${key}.${category}` as TranslationKey;
  const fallbackKey = `${key}.other` as TranslationKey;
  const resolvedKey = localizedKey in catalog ? localizedKey : fallbackKey;
  return translate(locale, resolvedKey, { ...values, count });
}

export function formatNumber(
  locale: SupportedLocale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(getLocaleInfo(locale).languageTag, options).format(value);
}

export function formatDate(
  locale: SupportedLocale,
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(getLocaleInfo(locale).languageTag, options).format(date);
}

export function formatList(
  locale: SupportedLocale,
  values: Iterable<string>,
  options?: Intl.ListFormatOptions,
): string {
  return new Intl.ListFormat(getLocaleInfo(locale).languageTag, options).format(values);
}
