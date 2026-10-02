export type Locale = 'es' | 'pt' | 'en';
export function normalizeLocale(value: unknown): Locale { return value === 'pt' || value === 'en' ? value : 'es'; }
