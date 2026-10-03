export type Locale = 'es' | 'pt' | 'en';
export const DEFAULT_LOCALE: Locale = 'en';
export function normalizeLocale(value: unknown): Locale { return value === 'es' || value === 'pt' ? value : DEFAULT_LOCALE; }
