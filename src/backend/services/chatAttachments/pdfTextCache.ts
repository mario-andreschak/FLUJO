import { webcrypto } from 'node:crypto';
import { extractPdfText, type PdfText } from './pdfText';

/**
 * Text of recently seen PDFs. A conversation re-sends its PDF on every turn,
 * and a model that cannot read PDFs gets the text instead, so the text is kept
 * for the most recent files. A failed read is forgotten at once so the next
 * turn tries again.
 */
const MAX_ENTRIES = 24;
const cache = new Map<string, Promise<PdfText>>();

async function keyFor(bytes: Uint8Array, limits: { maxPages: number; maxTextCharacters: number }): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return `${Buffer.from(digest).toString('hex')}:${limits.maxPages}:${limits.maxTextCharacters}`;
}

export async function cachedPdfText(
  bytes: Uint8Array,
  limits: { maxPages: number; maxTextCharacters: number },
): Promise<PdfText> {
  const key = await keyFor(bytes, limits);
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  const pending = extractPdfText(bytes, limits);
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  return pending;
}
