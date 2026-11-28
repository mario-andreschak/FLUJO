import { webcrypto } from 'node:crypto';
import os from 'node:os';
import sharp from 'sharp';
import type { PDFiumLibrary } from '@hyzyla/pdfium';
import { PdfReadError } from './pdfText';
import { yieldToEventLoop } from './textBudget';

/**
 * Pictures of PDF pages for models that see images but cannot read PDF files
 * (#1224). PDFium, the PDF engine of Chrome, draws each page. It is compiled
 * to WebAssembly, so it runs the same everywhere without a native build, and
 * it is loaded on first use only. A start that fails is retried on the next
 * PDF, and encoding happens on sharp's thread pool.
 */
export interface PdfPageImage {
  page: number;
  dataUrl: string;
}

export interface PdfPageImages {
  pages: number;
  images: PdfPageImage[];
}

/** Longest side of a page picture: small print stays legible, and vision models take it without shrinking. */
const LONG_SIDE = 1400;
/** A PNG larger than this is a photo or a scan, which JPEG stores far smaller. */
const PNG_CEILING = 1024 * 1024;

let library: Promise<PDFiumLibrary> | undefined;

function pdfium(): Promise<PDFiumLibrary> {
  if (!library) {
    const starting = import('@hyzyla/pdfium').then(module => module.PDFiumLibrary.init());
    library = starting;
    starting.catch(() => { if (library === starting) library = undefined; });
  }
  return library;
}

async function encode(rgba: Uint8Array, width: number, height: number): Promise<string> {
  const image = sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width, height, channels: 4 } }).removeAlpha();
  const png = await image.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  if (png.length <= PNG_CEILING) return `data:image/png;base64,${png.toString('base64')}`;
  const jpeg = await image.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

/**
 * Draw the first pages of a PDF, at most `maxPages` of them, stopping once
 * the pictures together reach `maxBytes` (what one message can carry for a
 * file). Copies the bytes, because PDFium takes over the buffer it is given.
 */
export async function renderPdfPages(bytes: Uint8Array, limits: { maxPages: number; maxBytes: number }): Promise<PdfPageImages> {
  const engine = await pdfium();
  let document: Awaited<ReturnType<PDFiumLibrary['loadDocument']>>;
  try {
    document = await engine.loadDocument(new Uint8Array(bytes));
  } catch (error) {
    throw new PdfReadError(/password/i.test(String((error as Error)?.message)) ? 'password' : 'damaged', error);
  }
  try {
    const pages = document.getPageCount();
    const images: PdfPageImage[] = [];
    let used = 0;
    for (let index = 0; index < Math.min(pages, limits.maxPages); index++) {
      const page = document.getPage(index);
      let dataUrl: string;
      try {
        const { originalWidth, originalHeight } = page.getOriginalSize();
        const scale = Math.min(4, LONG_SIDE / Math.max(1, originalWidth, originalHeight));
        const rendered = await page.render({ scale, render: 'bitmap' });
        dataUrl = await encode(rendered.data, rendered.width, rendered.height);
      } finally {
        page.close();
      }
      if (images.length > 0 && used + dataUrl.length > limits.maxBytes) break;
      used += dataUrl.length;
      images.push({ page: index + 1, dataUrl });
      await yieldToEventLoop();
    }
    return { pages, images };
  } finally {
    document.destroy();
  }
}

/**
 * Pictures of recently seen PDFs. A conversation re-sends its PDF on every
 * turn, so the pictures are drawn once; the cache holds a share of the
 * computer's memory and forgets a failed attempt at once.
 */
const cache = new Map<string, { size: number; pending: Promise<PdfPageImages> }>();
let cachedBytes = 0;

function cacheBudget(): number {
  return Math.min(256 * 1024 * 1024, Math.max(32 * 1024 * 1024, Math.floor(os.totalmem() / 128)));
}

function forget(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  cachedBytes -= entry.size;
}

export async function cachedPdfPages(bytes: Uint8Array, limits: { maxPages: number; maxBytes: number }): Promise<PdfPageImages> {
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const key = `${digest}:${limits.maxPages}:${limits.maxBytes}`;
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing.pending;
  }
  const pending = renderPdfPages(bytes, limits);
  const entry = { size: 0, pending };
  cache.set(key, entry);
  pending.then(result => {
    if (cache.get(key) !== entry) return;
    entry.size = result.images.reduce((total, image) => total + image.dataUrl.length, 0);
    cachedBytes += entry.size;
    const budget = cacheBudget();
    for (const oldest of cache.keys()) {
      if (cachedBytes <= budget || oldest === key) break;
      forget(oldest);
    }
  }, () => forget(key));
  return pending;
}
