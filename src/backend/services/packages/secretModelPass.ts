/**
 * Model-driven (optional) secret detector for package export (issue #195).
 *
 * Layer 2 of the two-layer detection. Only runs when the user opts in and picks
 * a model. Reuses the same backend completion path `generateFlow` uses
 * (`modelService.generateChatCompletion`), injected here as `completion` so the
 * detector stays pure and unit-testable without any model I/O.
 *
 * The model is asked to return a strict JSON array of proposals; its output is
 * UNTRUSTED and validated defensively: malformed entries are dropped, an
 * `excerpt` that does not actually occur in the referenced target's text is
 * rejected (anti-hallucination), `kind` is coerced to a known value, and the
 * secret name is re-sanitised. The detector NEVER throws on bad model output.
 *
 * PRIVACY: this is the one place package content leaves the machine. The UI
 * states this before it runs; here we simply cap how much is sent.
 */
import {
  SECRET_KINDS,
  secretProposalId,
  toProposalSecretName,
  type SecretKind,
  type SecretProposal,
} from '@/shared/types/package/secretProposal';
import { suggestSecretName } from './secretHeuristics';
import type { ScanTarget } from './secretScanTargets';

/** Minimal shape of `generateChatCompletion`'s result we rely on. */
export interface CompletionResultLike {
  success: boolean;
  completion?: {
    choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
  } | null;
  error?: { message?: string } | null;
}

/** The injected completion function (backend `modelService.generateChatCompletion`). */
export type ChatCompletionFn = (params: {
  modelIdentifier: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
}) => Promise<CompletionResultLike>;

export interface ModelPassOptions {
  modelIdentifier: string;
  completion: ChatCompletionFn;
  /** Cap on how many targets to send (protects the prompt + privacy surface). */
  maxTargets?: number;
  /** Cap on characters per target text sent to the model. */
  maxCharsPerTarget?: number;
}

export interface ModelPassResult {
  proposals: SecretProposal[];
  warnings: string[];
}

const DEFAULT_MAX_TARGETS = 200;
const DEFAULT_MAX_CHARS = 2000;

function buildSystemPrompt(): string {
  return [
    'You are a security assistant helping to package a workflow for sharing.',
    'You are given a JSON array of content slices, each { "location", "text" }.',
    'Identify substrings that are SECRETS or INSTANCE-SPECIFIC values that should',
    'NOT be shared verbatim: absolute file paths, owner/repo slugs, API tokens or',
    'keys, credential-bearing URLs, email addresses, and similar.',
    '',
    'Return ONLY a JSON array (no prose, no markdown fences). Each element:',
    '{ "location": string (echo the slice location exactly),',
    '  "excerpt": string (the EXACT substring, copied verbatim from that slice text),',
    '  "kind": one of "path"|"repo"|"token"|"email"|"url-cred"|"name"|"other",',
    '  "suggestedSecretName": UPPER_SNAKE identifier,',
    '  "suggestedDescription": short human description,',
    '  "rationale": one short sentence }.',
    'Do NOT invent excerpts that are not present in the given text. If nothing',
    'qualifies, return [].',
  ].join('\n');
}

/** Extract the first JSON array from possibly-fenced / chatty model output. */
export function extractJsonArray(content: string): unknown[] | null {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  // Strip a ```json ... ``` (or plain ```) fence if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1].trim();
  // Fast path: whole thing parses.
  const tryParse = (s: string): unknown[] | null => {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  // Fallback: slice from the first '[' to the last ']'.
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first >= 0 && last > first) return tryParse(text.slice(first, last + 1));
  return null;
}

function coerceKind(value: unknown): SecretKind {
  return typeof value === 'string' && (SECRET_KINDS as readonly string[]).includes(value)
    ? (value as SecretKind)
    : 'other';
}

/**
 * Validate one untrusted model entry against the targets it claims to describe.
 * Returns a well-formed `SecretProposal` or null (dropped).
 */
export function validateModelEntry(
  entry: unknown,
  targetByLocation: Map<string, ScanTarget>,
): SecretProposal | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const location = typeof e.location === 'string' ? e.location : '';
  const excerpt = typeof e.excerpt === 'string' ? e.excerpt.trim() : '';
  if (!location || !excerpt) return null;

  const target = targetByLocation.get(location);
  if (!target) return null; // unknown location -> hallucinated
  if (!target.text.includes(excerpt)) return null; // excerpt not actually present

  const kind = coerceKind(e.kind);
  const suggestedName =
    typeof e.suggestedSecretName === 'string' && e.suggestedSecretName.trim()
      ? toProposalSecretName('SECRET', e.suggestedSecretName)
      : suggestSecretName(kind, excerpt);

  return {
    id: secretProposalId(location, excerpt),
    location,
    excerpt,
    kind,
    source: 'model',
    suggestedSecretName: suggestedName,
    suggestedDescription:
      typeof e.suggestedDescription === 'string' ? e.suggestedDescription.slice(0, 200) : undefined,
    rationale: typeof e.rationale === 'string' ? e.rationale.slice(0, 200) : undefined,
  };
}

/**
 * Run the optional model-driven pass. Never throws: any provider or parse
 * failure is returned as a warning with an empty proposal list.
 */
export async function detectModelSecrets(
  targets: ScanTarget[],
  options: ModelPassOptions,
): Promise<ModelPassResult> {
  const warnings: string[] = [];
  if (targets.length === 0) return { proposals: [], warnings };

  const maxTargets = options.maxTargets ?? DEFAULT_MAX_TARGETS;
  const maxChars = options.maxCharsPerTarget ?? DEFAULT_MAX_CHARS;
  const trimmed = targets.slice(0, maxTargets).map((t) => ({
    location: t.location,
    text: t.text.length > maxChars ? t.text.slice(0, maxChars) : t.text,
  }));
  const targetByLocation = new Map<string, ScanTarget>(targets.map((t) => [t.location, t]));

  let result: CompletionResultLike;
  try {
    result = await options.completion({
      modelIdentifier: options.modelIdentifier,
      temperature: 0,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: JSON.stringify(trimmed) },
      ],
    });
  } catch (err) {
    warnings.push(`Model-driven pass failed: ${err instanceof Error ? err.message : String(err)}`);
    return { proposals: [], warnings };
  }

  if (!result?.success) {
    warnings.push(`Model-driven pass returned an error: ${result?.error?.message ?? 'unknown error'}`);
    return { proposals: [], warnings };
  }

  const content = result.completion?.choices?.[0]?.message?.content ?? '';
  const array = extractJsonArray(typeof content === 'string' ? content : '');
  if (!array) {
    warnings.push('Model-driven pass returned no parseable JSON; ignoring its output.');
    return { proposals: [], warnings };
  }

  const proposals: SecretProposal[] = [];
  const seen = new Set<string>();
  for (const entry of array) {
    const proposal = validateModelEntry(entry, targetByLocation);
    if (!proposal) continue;
    const key = `${proposal.location} ${proposal.excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push(proposal);
  }
  return { proposals, warnings };
}
