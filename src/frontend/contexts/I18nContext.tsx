"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  formatDate as formatLocalizedDate,
  formatList as formatLocalizedList,
  formatNumber as formatLocalizedNumber,
  translate,
  translatePlural,
  type TranslationValues,
} from '@/frontend/i18n/core';
import type { PluralTranslationKey, TranslationKey } from '@/frontend/i18n/messages';
import {
  DEFAULT_LOCALE,
  detectBrowserLocale,
  getLocaleInfo,
  LOCALE_STORAGE_KEY,
  resolveLocale,
  type LocaleInfo,
  type SupportedLocale,
} from '@/frontend/i18n/locales';

interface I18nContextValue {
  locale: SupportedLocale;
  localeInfo: LocaleInfo;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: TranslationKey, values?: TranslationValues) => string;
  tp: (key: PluralTranslationKey, count: number, values?: TranslationValues) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
  formatList: (values: Iterable<string>, options?: Intl.ListFormatOptions) => string;
}

const defaultValue: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  localeInfo: getLocaleInfo(DEFAULT_LOCALE),
  setLocale: () => {},
  t: (key, values) => translate(DEFAULT_LOCALE, key, values),
  tp: (key, count, values) => translatePlural(DEFAULT_LOCALE, key, count, values),
  formatNumber: (value, options) => formatLocalizedNumber(DEFAULT_LOCALE, value, options),
  formatDate: (value, options) => formatLocalizedDate(DEFAULT_LOCALE, value, options),
  formatList: (values, options) => formatLocalizedList(DEFAULT_LOCALE, values, options),
};

const I18nContext = createContext<I18nContextValue>(defaultValue);

function initialBrowserLocale(): SupportedLocale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    return resolveLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY)) ?? detectBrowserLocale();
  } catch {
    return detectBrowserLocale();
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // English is deterministic for SSR. Browser detection runs immediately after
  // hydration, avoiding a server/client markup mismatch on first load.
  const [locale, setLocaleState] = useState<SupportedLocale>(DEFAULT_LOCALE);

  const setLocale = useCallback((nextLocale: SupportedLocale) => {
    setLocaleState(nextLocale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // The UI can still change language when storage is blocked or unavailable.
    }
  }, []);

  useEffect(() => {
    setLocaleState(initialBrowserLocale());
  }, []);

  useEffect(() => {
    const info = getLocaleInfo(locale);
    document.documentElement.lang = info.languageTag;
    document.documentElement.dir = info.direction;
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  useEffect(() => {
    const syncAcrossTabs = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) return;
      setLocaleState(resolveLocale(event.newValue) ?? detectBrowserLocale());
    };
    window.addEventListener('storage', syncAcrossTabs);
    return () => window.removeEventListener('storage', syncAcrossTabs);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    localeInfo: getLocaleInfo(locale),
    setLocale,
    t: (key, values) => translate(locale, key, values),
    tp: (key, count, values) => translatePlural(locale, key, count, values),
    formatNumber: (number, options) => formatLocalizedNumber(locale, number, options),
    formatDate: (date, options) => formatLocalizedDate(locale, date, options),
    formatList: (values, options) => formatLocalizedList(locale, values, options),
  }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export default I18nContext;
