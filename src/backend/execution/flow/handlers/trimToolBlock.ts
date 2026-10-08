/**
 * trimToolBlock.ts — shrink the serialized tool block without changing what the
 * model can do.
 *
 * The tool block is the single largest fixed cost of a tool-using step: a
 * ProcessNode bound to a few MCP servers serializes ~20k tokens of tool
 * definitions, and because Chat Completions is stateless that block is re-sent on
 * every turn of the agentic loop. Prompt caching discounts the re-read but does
 * not remove it, and it consumes context window at full size regardless.
 *
 * Two tiers, deliberately separated by risk:
 *
 * TIER A — lossless, always on. Removes bytes that carry no information for a
 * model choosing arguments: JSON Schema bookkeeping keywords, annotations that
 * only describe an OUTPUT contract, titles that merely restate the property name,
 * and the indentation of descriptions written as indented template literals. A
 * model's behaviour cannot depend on any of it.
 *
 * TIER B — lossy, opt-in. Caps description lengths. This genuinely removes
 * information, so it is gated behind an explicit setting and truncates at a
 * sentence boundary so the surviving text is never a fragment. Verbose MCP servers
 * are where the real tokens are, but "the model no longer knows about a caveat in
 * sentence five" is a behaviour change and must be the user's choice.
 *
 * Both tiers are PURE functions of their input, so the resulting block stays
 * byte-identical turn to turn — the #89 prefix-cache invariant is preserved. Order
 * is untouched (ToolHandler already sorts by name).
 */

import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/flow/execution/handlers/trimToolBlock');

/**
 * JSON Schema keywords dropped by Tier A.
 *
 * - `$schema` / `$id` / `$comment` — document bookkeeping, never semantic.
 * - `deprecated` / `readOnly` / `writeOnly` — annotations about a value's
 *   lifecycle or an OUTPUT contract. A tool's `inputSchema` is only ever used to
 *   construct an argument object, so none of them can affect the model's choice.
 * - `additionalItems` — removed from modern JSON Schema and ignored by providers.
 *
 * Notably NOT dropped: `default`, `enum`, `const`, `required`,
 * `additionalProperties`, `minimum`/`maximum`, `pattern`. Each of those changes
 * what a VALID argument looks like, so removing them would produce failing tool
 * calls. `examples` is also kept — it is genuinely instructive — and is only
 * touched when the opt-in tier is on.
 */
const DROPPED_KEYWORDS = [
  '$schema',
  '$id',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
  'additionalItems',
] as const;

/** Normalize for the title-vs-key comparison: "Max Results" ≡ max_results. */
const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Tidy a description without changing its meaning.
 *
 * MCP tool descriptions are overwhelmingly written as indented template literals,
 * so every line arrives with the source file's indentation attached — pure token
 * waste. This removes trailing whitespace, strips the common leading indentation,
 * and collapses runs of blank lines. Line structure is PRESERVED rather than
 * collapsed to one line, because descriptions routinely contain markdown lists and
 * fenced code where newlines are meaningful.
 */
export function tidyDescription(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));

  // Common leading indentation across non-blank lines (ignoring the first line,
  // which in a template literal starts right after the backtick).
  const indents = lines
    .slice(1)
    .filter((l) => l.length > 0)
    .map((l) => l.match(/^ */)![0].length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;

  const dedented = lines.map((l, i) => (i === 0 ? l : l.slice(common)));

  return dedented
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Truncate at a sentence boundary at or before `max`, falling back to a word
 * boundary, so the kept text is never a mid-word or mid-clause fragment. The
 * ellipsis signals to the model that the description was shortened rather than
 * being all there is to know.
 */
export function truncateAtBoundary(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;

  const window = text.slice(0, max);
  const lastSentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('.\n'),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  // Only honour a sentence break that keeps a useful amount of the text.
  if (lastSentence > max * 0.5) return `${window.slice(0, lastSentence + 1)} […]`;

  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > max * 0.5 ? lastSpace : max;
  return `${window.slice(0, cut).trimEnd()} […]`;
}

export interface TrimOptions {
  /**
   * Tier B: cap on each tool's own description, in characters. 0/undefined
   * disables capping (Tier A still applies).
   */
  descriptionMaxChars?: number;
  /**
   * Tier B: cap on each individual property description. Defaults to a quarter of
   * `descriptionMaxChars` when capping is on — per-property prose is usually the
   * bulk of a large schema, and each one needs far less room than the tool's own
   * summary.
   */
  propertyDescriptionMaxChars?: number;
}

/** Recursively prune one schema node. Returns a new object; never mutates. */
function pruneSchema(node: unknown, propertyKey: string | undefined, opts: TrimOptions): unknown {
  if (Array.isArray(node)) return node.map((n) => pruneSchema(n, undefined, opts));
  if (!node || typeof node !== 'object') return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if ((DROPPED_KEYWORDS as readonly string[]).includes(key)) continue;

    // A title that merely restates the property name is pure duplication.
    if (key === 'title' && typeof value === 'string' && propertyKey) {
      if (normalizeName(value) === normalizeName(propertyKey)) continue;
    }

    if (key === 'description' && typeof value === 'string') {
      const tidied = tidyDescription(value);
      const cap = opts.propertyDescriptionMaxChars ?? 0;
      out[key] = cap > 0 ? truncateAtBoundary(tidied, cap) : tidied;
      continue;
    }

    // `properties` / `$defs` are maps of name -> schema: recurse with the name so
    // the title check above has something to compare against.
    if ((key === 'properties' || key === '$defs' || key === 'definitions') && value && typeof value === 'object') {
      const mapped: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        mapped[name] = pruneSchema(sub, name, opts);
      }
      out[key] = mapped;
      continue;
    }

    if (key === 'examples' && opts.propertyDescriptionMaxChars) {
      // Only dropped when the opt-in tier is on — examples are instructive, but
      // they are also frequently large.
      continue;
    }

    out[key] = pruneSchema(value, undefined, opts);
  }

  return out;
}

export interface TrimResult {
  tools: OpenAI.ChatCompletionFunctionTool[];
  /** Serialized length of the block before trimming. */
  beforeChars: number;
  /** Serialized length after trimming. */
  afterChars: number;
}

/**
 * Trim a tool block. Tier A always applies; Tier B applies only when
 * `descriptionMaxChars` is set. Returns the sizes so the saving can be logged and
 * verified rather than assumed.
 */
export function trimTools(
  tools: OpenAI.ChatCompletionFunctionTool[] | undefined,
  opts: TrimOptions = {},
): TrimResult {
  if (!tools || tools.length === 0) {
    return { tools: tools ?? [], beforeChars: 0, afterChars: 0 };
  }

  const descCap = opts.descriptionMaxChars ?? 0;
  const effective: TrimOptions = {
    descriptionMaxChars: descCap,
    propertyDescriptionMaxChars:
      opts.propertyDescriptionMaxChars ?? (descCap > 0 ? Math.max(80, Math.floor(descCap / 4)) : 0),
  };

  const beforeChars = JSON.stringify(tools).length;

  const trimmed = tools.map((t) => {
    if (t.type !== 'function') return t;
    const description = t.function.description ? tidyDescription(t.function.description) : t.function.description;
    return {
      ...t,
      function: {
        ...t.function,
        ...(description !== undefined
          ? { description: descCap > 0 ? truncateAtBoundary(description, descCap) : description }
          : {}),
        ...(t.function.parameters
          ? { parameters: pruneSchema(t.function.parameters, undefined, effective) as Record<string, unknown> }
          : {}),
      },
    } as OpenAI.ChatCompletionFunctionTool;
  });

  const afterChars = JSON.stringify(trimmed).length;

  if (afterChars < beforeChars) {
    log.debug('Trimmed tool block', {
      toolCount: tools.length,
      beforeChars,
      afterChars,
      savedChars: beforeChars - afterChars,
      savedPct: Math.round(((beforeChars - afterChars) / beforeChars) * 1000) / 10,
      descriptionCap: descCap || null,
    });
  }

  return { tools: trimmed, beforeChars, afterChars };
}
