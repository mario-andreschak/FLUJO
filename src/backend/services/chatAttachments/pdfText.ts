import { TextBudget, yieldToEventLoop } from './textBudget';
import type { ExtractedText } from './officeText';

interface PdfTextItem { str?: string; hasEOL?: boolean }
interface PdfPage {
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup?(): unknown;
}
interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  loadingTask?: { destroy(): Promise<void> };
}

/**
 * unpdf ships a build of Mozilla's PDF.js that needs no worker file, so it
 * runs the same in development, in the packaged app and in Docker. It is
 * loaded on first use only.
 */
async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const { getDocumentProxy } = await import('unpdf');
  return await getDocumentProxy(bytes, { stopAtErrors: false });
}

export interface PdfText extends ExtractedText {
  pages: number;
  /** False for scans and drawings: there is no text a model could read. */
  hasText: boolean;
}

export class PdfReadError extends Error {
  constructor(readonly reason: 'password' | 'damaged', cause?: unknown) {
    super(reason === 'password' ? 'The PDF is protected with a password' : 'The PDF could not be read', { cause });
  }
}

function pageText(items: unknown[]): string {
  const parts: string[] = [];
  for (const raw of items) {
    const item = raw as PdfTextItem;
    if (typeof item.str !== 'string') continue;
    parts.push(item.str);
    if (item.hasEOL) parts.push('\n');
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Copy the bytes: PDF.js takes ownership of the buffer it is given. */
export async function extractPdfText(
  bytes: Uint8Array,
  limits: { maxPages: number; maxTextCharacters: number },
): Promise<PdfText> {
  let document: PdfDocument;
  try {
    document = await openPdf(new Uint8Array(bytes));
  } catch (error) {
    const name = (error as { name?: unknown })?.name;
    throw new PdfReadError(name === 'PasswordException' ? 'password' : 'damaged', error);
  }
  const budget = new TextBudget(limits.maxTextCharacters);
  const pages = document.numPages;
  const keep = Math.min(pages, limits.maxPages);
  let hasText = false;
  let read = 0;
  try {
    for (let pageNumber = 1; pageNumber <= keep; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const text = pageText((await page.getTextContent()).items);
      page.cleanup?.();
      read = pageNumber;
      if (text) hasText = true;
      if (!budget.push(`## Page ${pageNumber}\n${text || '(no text on this page)'}\n\n`)) break;
      await yieldToEventLoop();
    }
  } finally {
    await document.loadingTask?.destroy().catch(() => undefined);
  }
  return {
    text: hasText ? budget.toString() : '',
    pages,
    units: pages,
    hasText,
    shortened: keep < pages
      ? { unit: 'page', kept: keep, total: pages }
      : budget.full ? { unit: 'page', kept: read, total: pages } : undefined,
  };
}
