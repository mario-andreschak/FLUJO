import { formatDate, formatNumber, translate, translatePlural } from '@/frontend/i18n/core';
import { catalogs } from '@/frontend/i18n/messages';
import { localizeFlowIssue } from '@/frontend/i18n/flowValidation';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectBrowserLocale,
  resolveLocale,
} from '@/frontend/i18n/locales';

describe('i18n core', () => {
  it.each([
    ['en-US', 'en'],
    ['es-CO', 'es'],
    ['de-DE', 'de'],
    ['fr-CA', 'fr'],
    ['it-IT', 'it'],
    ['pt-BR', 'pt'],
    ['zh-Hans-CN', 'zh-CN'],
    ['zh_TW', 'zh-CN'],
  ] as const)('resolves %s to %s', (input, expected) => {
    expect(resolveLocale(input)).toBe(expected);
  });

  it('falls back to English when browser preferences are unsupported', () => {
    expect(detectBrowserLocale(['ja-JP', 'ko-KR'])).toBe(DEFAULT_LOCALE);
    expect(detectBrowserLocale(['ja-JP', 'de-AT'])).toBe('de');
    expect(resolveLocale('ja-JP')).toBeNull();
  });

  it('ships a complete non-empty catalog for every supported locale', () => {
    const englishKeys = Object.keys(catalogs.en);

    expect(SUPPORTED_LOCALES).toHaveLength(7);
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(catalogs[locale.code])).toEqual(englishKeys);
      expect(Object.values(catalogs[locale.code]).every((message) => message.trim().length > 0)).toBe(true);
    }
  });

  it('interpolates values and formats values using the active locale', () => {
    expect(translate('es', 'home.step', { number: 2 })).toBe('Paso 2');
    expect(translatePlural('zh-CN', 'home.updateReady', 3, { branch: 'main' }))
      .toContain('main');
    expect(translatePlural('de', 'home.updateReady', 1, { branch: 'main' }))
      .toContain('1 neue Änderung');
    expect(formatNumber('en', 1234.5)).not.toBe(formatNumber('de', 1234.5));
    expect(formatDate('en', '2026-07-31T00:00:00Z', { timeZone: 'UTC', dateStyle: 'medium' }))
      .not.toBe(formatDate('zh-CN', '2026-07-31T00:00:00Z', { timeZone: 'UTC', dateStyle: 'medium' }));
  });

  it('uses grammatical plural forms instead of translating isolated words', () => {
    expect(translatePlural('de', 'statistics.duration.days', 1, { value: 1 })).toBe('1 Tag');
    expect(translatePlural('de', 'statistics.duration.days', 2, { value: 2 })).toBe('2 Tage');
    expect(translatePlural('es', 'statistics.duration.days', 1, { value: 1 })).toBe('1 día');
  });

  it('localizes stable validation codes while preserving node context', () => {
    const issue = {
      code: 'process-missing-model',
      message: 'Process node "Writer" has no model bound.',
      nodeLabel: 'Writer',
    };
    expect(localizeFlowIssue(issue, (key, values) => translate('de', key, values)))
      .toBe('Dem Prozessknoten „Writer“ ist kein Modell zugewiesen.');
  });
});
