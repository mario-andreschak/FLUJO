import OpenAI from 'openai';
import { createHash, randomUUID } from 'crypto';
import { deflateSync } from 'zlib';
import { writeRunResource } from '@/backend/services/runResources';
import type { Model } from '@/shared/types/model';
import type {
  VisionInputCapability,
  VisualArchiveCandidate,
  VisualArchiveExactString,
  VisualArchivePageMetadata,
  VisualCompactionDiagnostic,
  VisualCompactionEstimates,
} from '@/shared/types/visualArchive';
import {
  commitFlowDurableMutation,
  type FlowDurableMutationContext,
} from '@/backend/execution/flow/executionAuthority';

const RECENT_MESSAGE_FLOOR = 6;
const MIN_CANDIDATE_CHARS = 12_000;
const MIN_TEXT_DENSITY = 0.55;
const PAGE_COLUMNS = 116;
const PAGE_ROWS = 78;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const CELL_WIDTH = 6;
const CELL_HEIGHT = 8;

export interface EffectiveVisualCompaction {
  enabled: boolean;
  toolResultsOnly: boolean;
  evaluationOnly: boolean;
  /** Test-only escape hatch. Never loaded from persisted user settings. */
  visionCapabilityOverride?: VisionInputCapability;
}

export interface VisualCompactionResult {
  messages: OpenAI.ChatCompletionMessageParam[];
  diagnostic: VisualCompactionDiagnostic;
}

interface CandidateChunk {
  start: number;
  end: number;
  toolPair: boolean;
  text: string;
  exactStrings: VisualArchiveExactString[];
}

interface RenderedPage {
  base64: string;
  metadata: VisualArchivePageMetadata;
}

const FONT: Record<string, string[]> = {
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110'],
  '.': ['00000','00000','00000','00000','00000','00110','00110'],
  ',': ['00000','00000','00000','00000','00110','00110','00100'],
  ':': ['00000','00110','00110','00000','00110','00110','00000'],
  ';': ['00000','00110','00110','00000','00110','00110','00100'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '_': ['00000','00000','00000','00000','00000','00000','11111'],
  '/': ['00001','00010','00010','00100','01000','01000','10000'],
  '\\': ['10000','01000','01000','00100','00010','00010','00001'],
  '[': ['01110','01000','01000','01000','01000','01000','01110'],
  ']': ['01110','00010','00010','00010','00010','00010','01110'],
  '(': ['00010','00100','01000','01000','01000','00100','00010'],
  ')': ['01000','00100','00010','00010','00010','00100','01000'],
  '{': ['00010','00100','00100','01000','00100','00100','00010'],
  '}': ['01000','00100','00100','00010','00100','00100','01000'],
  '=': ['00000','11111','00000','11111','00000','00000','00000'],
  '+': ['00000','00100','00100','11111','00100','00100','00000'],
  '*': ['00000','10101','01110','11111','01110','10101','00000'],
  '#': ['01010','11111','01010','01010','11111','01010','00000'],
  '@': ['01110','10001','10111','10101','10111','10000','01110'],
  '?': ['01110','10001','00001','00010','00100','00000','00100'],
  '!': ['00100','00100','00100','00100','00100','00000','00100'],
  '"': ['01010','01010','01010','00000','00000','00000','00000'],
  "'": ['00100','00100','00000','00000','00000','00000','00000'],
  '|': ['00100','00100','00100','00100','00100','00100','00100'],
  '<': ['00010','00100','01000','10000','01000','00100','00010'],
  '>': ['01000','00100','00010','00001','00010','00100','01000'],
};

function messageText(message: OpenAI.ChatCompletionMessageParam): string {
  const parts: string[] = [`[${message.role}]`];
  if (typeof message.content === 'string') parts.push(message.content);
  else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') parts.push(part.text);
    }
  }
  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call.type === 'function') parts.push(`[tool ${call.function.name}] ${call.function.arguments}`);
    }
  }
  if (message.role === 'tool') parts.push(`[tool_call_id ${message.tool_call_id}]`);
  return parts.join('\n');
}

function findExactStrings(text: string): VisualArchiveExactString[] {
  const patterns: Array<[VisualArchiveExactString['kind'], RegExp]> = [
    ['url', /\b(?:https?|file):\/\/[^\s"'<>]+/gi],
    ['path', /\b[A-Za-z]:\\[^\r\n"']+|(?:^|\s)\/(?:[^\s/]+\/)+[^\s"']*/gm],
    ['hash', /\b[a-f0-9]{32,128}\b/gi],
    ['id', /\b(?:[A-Za-z][A-Za-z0-9_-]*[-_:])?[A-Za-z0-9_-]{16,}\b/g],
    ['error', /\b(?:error|exception|failed|errno)\b[^\r\n]{0,240}/gi],
    ['command', /(?:^|\n)\s*(?:\$|>|PS>)?\s*(?:git|npm|pnpm|yarn|node|python|docker|kubectl|curl|wget)\s+[^\r\n]+/gi],
    ['tool', /\[tool(?:_call_id)?\s+[^\]]+\]/gi],
  ];
  const seen = new Set<string>();
  const values: VisualArchiveExactString[] = [];
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].trim();
      const key = `${kind}:${value}`;
      if (!value || seen.has(key)) continue;
      seen.add(key);
      values.push({ kind, value });
      if (values.length >= 80) return values;
    }
  }
  return values;
}

export function detectVisualArchiveSecret(text: string): boolean {
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bgh[opsu]_[A-Za-z0-9]{30,}\b/,
    /\b(?:authorization\s*:\s*bearer|bearer)\s+[A-Za-z0-9._~+\/-]{16,}/i,
    /\b(?:api[_-]?key|client[_-]?secret|password|passwd|access[_-]?token)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  ];
  return secretPatterns.some((pattern) => pattern.test(text));
}

function completeChunks(messages: OpenAI.ChatCompletionMessageParam[], eligibleEnd: number): CandidateChunk[] {
  const chunks: CandidateChunk[] = [];
  let index = 0;
  while (index < eligibleEnd) {
    const message = messages[index];
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const ids = new Set(message.tool_calls.map((call) => call.id));
      let end = index + 1;
      const found = new Set<string>();
      while (end < eligibleEnd && messages[end].role === 'tool') {
        found.add((messages[end] as OpenAI.ChatCompletionToolMessageParam).tool_call_id);
        end += 1;
      }
      if ([...ids].every((id) => found.has(id))) {
        const text = messages.slice(index, end).map(messageText).join('\n\n');
        chunks.push({ start: index, end, toolPair: true, text, exactStrings: findExactStrings(text) });
        index = end;
        continue;
      }
    }
    const text = messageText(message);
    chunks.push({ start: index, end: index + 1, toolPair: false, text, exactStrings: findExactStrings(text) });
    index += 1;
  }
  return chunks;
}

export function selectVisualArchiveCandidate(
  messages: OpenAI.ChatCompletionMessageParam[],
  toolResultsOnly: boolean,
): { candidate?: VisualArchiveCandidate; text?: string; reason?: 'no-eligible-range' | 'below-size-threshold' | 'poor-density' } {
  const eligibleEnd = Math.max(0, messages.length - RECENT_MESSAGE_FLOOR);
  if (eligibleEnd === 0) return { reason: 'no-eligible-range' };
  const chunks = completeChunks(messages, eligibleEnd)
    .filter((chunk) => !toolResultsOnly || chunk.toolPair)
    .sort((a, b) => b.text.length - a.text.length);
  const selected = chunks[0];
  if (!selected) return { reason: 'no-eligible-range' };
  if (selected.text.length < MIN_CANDIDATE_CHARS) return { reason: 'below-size-threshold' };
  const visible = selected.text.match(/[\p{L}\p{N}\p{P}\p{S}]/gu)?.length ?? 0;
  const density = selected.text.length === 0 ? 0 : visible / selected.text.length;
  if (density < MIN_TEXT_DENSITY) return { reason: 'poor-density' };
  return {
    candidate: {
      startIndex: selected.start,
      endIndex: selected.end,
      messageCount: selected.end - selected.start,
      originalCharacters: selected.text.length,
      textDensity: density,
      toolResultsOnly,
      exactStrings: selected.exactStrings,
    },
    text: selected.text,
  };
}

export function resolveVisionInputCapability(
  model: Pick<Model, 'inputModalities' | 'adapter' | 'visionInputCapability'>,
  override?: VisionInputCapability,
): VisionInputCapability {
  if (override) return override;
  if (model.adapter === 'claude-cli' || model.adapter === 'codex-cli') return 'unsupported';
  if (model.visionInputCapability) return model.visionInputCapability;
  if (!Array.isArray(model.inputModalities) || model.inputModalities.length === 0) return 'unknown';
  return model.inputModalities.some((value) => /^(?:image|vision)$/i.test(value))
    ? 'supported'
    : 'unsupported';
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function renderPage(text: string, pageIndex: number): RenderedPage {
  const width = PAGE_COLUMNS * CELL_WIDTH;
  const height = PAGE_ROWS * CELL_HEIGHT;
  const pixels = Buffer.alloc((width + 1) * height, 255);
  for (let y = 0; y < height; y += 1) pixels[y * (width + 1)] = 0;
  const pageText = text.toUpperCase().replace(/\t/g, '  ').replace(/[^\x20-\x7E\n]/g, '?');
  const logicalLines: string[] = [];
  for (const rawLine of pageText.split(/\r?\n/)) {
    if (rawLine.length === 0) logicalLines.push(' ');
    for (let start = 0; start < rawLine.length; start += PAGE_COLUMNS) logicalLines.push(rawLine.slice(start, start + PAGE_COLUMNS));
  }
  for (let row = 0; row < Math.min(PAGE_ROWS, logicalLines.length); row += 1) {
    const line = logicalLines[row];
    for (let column = 0; column < Math.min(PAGE_COLUMNS, line.length); column += 1) {
      const glyph = FONT[line[column]] ?? FONT['?'];
      for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
        for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
          if (glyph[gy][gx] === '1') pixels[(row * CELL_HEIGHT + gy) * (width + 1) + 1 + column * CELL_WIDTH + gx] = 0;
        }
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return { base64: png.toString('base64'), metadata: { index: pageIndex, width, height, bytes: png.length, imageTokens: 0 } };
}

export function renderVisualArchivePages(text: string): RenderedPage[] {
  // Wrap before pagination so newline-heavy logs cannot overflow a page and
  // silently disappear from the visual navigation copy.
  const logicalLines: string[] = [];
  for (const rawLine of text.replace(/\t/g, '  ').split(/\r?\n/)) {
    if (rawLine.length === 0) logicalLines.push(' ');
    else for (let start = 0; start < rawLine.length; start += PAGE_COLUMNS) {
      logicalLines.push(rawLine.slice(start, start + PAGE_COLUMNS));
    }
  }
  const pages: RenderedPage[] = [];
  for (let offset = 0; offset < logicalLines.length; offset += PAGE_ROWS) {
    pages.push(renderPage(logicalLines.slice(offset, offset + PAGE_ROWS).join('\n'), pages.length));
  }
  return pages;
}

export function estimateVisualPageTokens(
  provider: Model['provider'],
  page: Pick<VisualArchivePageMetadata, 'width' | 'height'>,
): number {
  if (provider === 'gemini') return 258;
  if (provider === 'anthropic') return Math.ceil((page.width * page.height) / 750);
  if (provider === 'openai' || provider === 'openrouter' || provider === 'requesty') {
    return 85 + 170 * Math.ceil(page.width / 512) * Math.ceil(page.height / 512);
  }
  return Math.ceil((page.width * page.height) / 600);
}

export function estimateVisualRoutes(
  originalCharacters: number,
  sidecarCharacters: number,
  pages: RenderedPage[],
  provider: Model['provider'],
): VisualCompactionEstimates {
  const rawTextTokens = Math.ceil(originalCharacters / 4);
  const compactedTextTokens = Math.ceil(Math.min(originalCharacters, 2_400) / 4) + 80;
  const summaryTokens = Math.max(256, Math.ceil(rawTextTokens * 0.12));
  const sidecarTokens = Math.ceil(sidecarCharacters / 4);
  const imageTokens = pages.reduce((sum, page) => sum + estimateVisualPageTokens(provider, page.metadata), 0);
  const selectedTokens = imageTokens + sidecarTokens;
  const netSavings = rawTextTokens - selectedTokens;
  return {
    rawTextTokens,
    compactedTextTokens,
    summaryTokens,
    imageTokens,
    sidecarTokens,
    selectedTokens,
    netSavings,
    savingsPercent: rawTextTokens === 0 ? 0 : (netSavings / rawTextTokens) * 100,
  };
}

function manifestText(candidate: VisualArchiveCandidate, sourceUri: string, sha256: string): string {
  const exact = candidate.exactStrings.length > 0
    ? candidate.exactStrings.map((item) => `- ${item.kind}: ${item.value}`).join('\n')
    : '- none detected';
  return [
    '[Visual context archive: navigation copy; exact source remains authoritative]',
    `Source: ${sourceUri}`,
    `SHA-256: ${sha256}`,
    `Archived messages: ${candidate.messageCount}; original characters: ${candidate.originalCharacters}`,
    'Exact-string sidecar:',
    exact,
    'Use read_resource with the Source URI for exact content and verification metadata.',
  ].join('\n');
}

export async function compactMessagesVisually(input: {
  messages: OpenAI.ChatCompletionMessageParam[];
  model: Model;
  conversationId?: string;
  nodeId?: string;
  config: EffectiveVisualCompaction;
  durableContext?: FlowDurableMutationContext;
}): Promise<VisualCompactionResult> {
  const startedAt = Date.now();
  const capability = resolveVisionInputCapability(input.model, input.config.visionCapabilityOverride);
  const baseDiagnostic: VisualCompactionDiagnostic = {
    enabled: input.config.enabled,
    evaluationOnly: input.config.evaluationOnly,
    provider: input.model.provider,
    adapter: input.model.adapter,
    model: input.model.name,
    capability,
    route: 'raw',
    pages: [],
    latencyMs: 0,
    renderedBytes: 0,
  };
  const finish = (patch: Partial<VisualCompactionDiagnostic>, messages = input.messages): VisualCompactionResult => ({
    messages,
    diagnostic: { ...baseDiagnostic, ...patch, latencyMs: Date.now() - startedAt },
  });
  if (!input.config.enabled) return finish({ fallbackReason: 'disabled' });
  if (!input.conversationId) return finish({ fallbackReason: 'missing-conversation' });
  if (input.model.adapter === 'claude-cli' || input.model.adapter === 'codex-cli') {
    return finish({ fallbackReason: 'self-orchestrating-adapter' });
  }
  if (capability !== 'supported') {
    return finish({ fallbackReason: capability === 'unknown' ? 'vision-unknown' : 'vision-unsupported' });
  }
  const selected = selectVisualArchiveCandidate(input.messages, input.config.toolResultsOnly);
  if (!selected.candidate || !selected.text) return finish({ fallbackReason: selected.reason ?? 'no-eligible-range' });
  if (detectVisualArchiveSecret(selected.text)) {
    return finish({ candidate: selected.candidate, fallbackReason: 'secret-detected' });
  }
  let pages: RenderedPage[];
  try {
    pages = renderVisualArchivePages(selected.text);
  } catch {
    return finish({ candidate: selected.candidate, fallbackReason: 'render-failed' });
  }
  const archiveId = randomUUID();
  const sourceJson = JSON.stringify({
    version: 1,
    archiveId,
    range: { start: selected.candidate.startIndex, end: selected.candidate.endIndex },
    messages: input.messages.slice(selected.candidate.startIndex, selected.candidate.endIndex),
  });
  const sha256 = createHash('sha256').update(sourceJson).digest('hex');
  const provisionalManifest = manifestText(selected.candidate, 'flujo://run/pending', sha256);
  const estimates = estimateVisualRoutes(selected.candidate.originalCharacters, provisionalManifest.length, pages, input.model.provider);
  pages.forEach((page) => { page.metadata.imageTokens = estimateVisualPageTokens(input.model.provider, page.metadata); });
  if (!(estimates.netSavings > 0)) {
    return finish({
      candidate: selected.candidate,
      estimates,
      pages: pages.map((page) => page.metadata),
      renderedBytes: pages.reduce((sum, page) => sum + page.metadata.bytes, 0),
      route: estimates.compactedTextTokens <= estimates.rawTextTokens ? 'text' : 'raw',
      fallbackReason: 'non-positive-savings',
    });
  }
  if (input.config.evaluationOnly) {
    return finish({
      candidate: selected.candidate,
      estimates,
      pages: pages.map((page) => page.metadata),
      renderedBytes: pages.reduce((sum, page) => sum + page.metadata.bytes, 0),
      fallbackReason: 'evaluation-only',
    });
  }
  const archive = await commitFlowDurableMutation(input.durableContext ?? {}, async () => {
    const source = await writeRunResource({
      conversationId: input.conversationId!,
      mimeType: 'application/vnd.flujo.visual-archive+json',
      kind: 'text',
      data: { text: sourceJson },
      producedBy: { source: 'visual-archive', nodeId: input.nodeId },
      archive: { archiveId, role: 'source', pageCount: pages.length, route: 'image', sourceSha256: sha256 },
    });
    if ('skipped' in source) return null;
    const pageMetadata: VisualArchivePageMetadata[] = [];
    for (const page of pages) {
      const stored = await writeRunResource({
        conversationId: input.conversationId!,
        mimeType: 'image/png',
        kind: 'image',
        data: { base64: page.base64 },
        producedBy: { source: 'visual-archive', nodeId: input.nodeId },
        archive: { archiveId, role: 'page', pageIndex: page.metadata.index, pageCount: pages.length, route: 'image', sourceSha256: sha256 },
      });
      if ('skipped' in stored) return null;
      pageMetadata.push({ ...page.metadata, resourceUri: stored.uri });
    }
    return { source, pageMetadata };
  });
  if (!archive) return finish({ candidate: selected.candidate, estimates, fallbackReason: 'stash-failed' });
  const { source, pageMetadata } = archive;
  const manifest = manifestText(selected.candidate, source.uri, sha256);
  const content: OpenAI.ChatCompletionContentPart[] = [
    { type: 'text', text: manifest },
    ...pages.map((page) => ({ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${page.base64}`, detail: 'low' as const } })),
  ];
  const archiveMessage: OpenAI.ChatCompletionUserMessageParam = { role: 'user', content };
  const messages = [
    ...input.messages.slice(0, selected.candidate.startIndex),
    archiveMessage,
    ...input.messages.slice(selected.candidate.endIndex),
  ];
  return finish({
    route: 'image',
    candidate: selected.candidate,
    estimates,
    pages: pageMetadata,
    sourceResourceUri: source.uri,
    sourceSha256: sha256,
    renderedBytes: pageMetadata.reduce((sum, page) => sum + page.bytes, 0),
  }, messages);
}
