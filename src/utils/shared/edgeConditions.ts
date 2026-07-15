/**
 * Deterministic edge conditions (Tier 2b — data-driven routing).
 *
 * A control edge may carry a predicate over the conversation's last message.
 * The flow engine evaluates it deterministically (no model tool call) and takes
 * the first outgoing edge whose predicate matches; a bare (predicate-less) edge
 * is the default/fallback. This lets a flow branch on "did the step say PASS or
 * FAIL" without depending on a small model reliably emitting a handoff tool call.
 *
 * This module is intentionally pure and dependency-light so it can run in the
 * browser (Flow builder / spec validation) and on the backend (ProcessNode.post)
 * alike. `evaluateCondition` NEVER throws — an invalid regex degrades to "no
 * match" so a typo in a predicate can never crash a run.
 */

export type EdgeConditionKind = 'contains' | 'regex' | 'equals';
export type EdgeConditionTarget = 'last-assistant' | 'last-message';

export interface EdgeCondition {
  /** How `value` is matched against the selected message. */
  kind: EdgeConditionKind;
  /** The literal (contains/equals) or regex source (regex) to match. */
  value: string;
  /** Which message to test. Default 'last-assistant' (the step's own output). */
  target?: EdgeConditionTarget;
  /** Case-insensitive matching. For contains/equals it lowercases both sides;
   *  for regex it adds the `i` flag (JS regex has no `(?i)` inline flags). Default false. */
  ignoreCase?: boolean;
  /** Negate the match. Default false. Not applied when a regex fails to compile
   *  (a broken predicate must never route). */
  negate?: boolean;
}

export const EDGE_CONDITION_KINDS: readonly EdgeConditionKind[] = ['contains', 'regex', 'equals'];
export const EDGE_CONDITION_TARGETS: readonly EdgeConditionTarget[] = ['last-assistant', 'last-message'];

/** True when `kind` is a known condition kind. */
export function isValidConditionKind(kind: unknown): kind is EdgeConditionKind {
  return typeof kind === 'string' && (EDGE_CONDITION_KINDS as readonly string[]).includes(kind);
}

/** True when `pattern` compiles as a JS RegExp (used by validation to warn early). */
export function isRegexCompilable(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Coerce a chat message's `content` into a plain string. OpenAI content can be a
 * string or an array of parts; we join the text parts and drop non-text parts.
 * Anything else (null/undefined/object) becomes ''.
 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** A minimal message shape the selector needs — role + content. */
interface SelectableMessage {
  role?: string;
  content?: unknown;
}

/**
 * Pick the text a condition tests, per its `target`:
 *   - 'last-assistant' (default): the most recent assistant message's text —
 *     the natural "what did this step say". Returns null if there is none.
 *   - 'last-message': the most recent message of any role (may be a tool result).
 * Returns null when no suitable message exists.
 */
export function selectConditionText(
  messages: SelectableMessage[] | undefined | null,
  target: EdgeConditionTarget = 'last-assistant'
): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  if (target === 'last-message') {
    return messageText(messages[messages.length - 1]?.content);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messageText(messages[i]?.content);
  }
  return null;
}

/**
 * Evaluate a predicate against a message string. Pure and total — never throws.
 * An invalid regex logs a warning and evaluates to `false` (edge not taken),
 * with `negate` NOT applied, so a broken predicate can never hijack routing.
 */
export function evaluateCondition(
  cond: EdgeCondition | undefined | null,
  message: string | null | undefined
): boolean {
  if (!cond) return false;
  const text = typeof message === 'string' ? message : '';
  const value = typeof cond.value === 'string' ? cond.value : String(cond.value ?? '');

  let matched: boolean;
  switch (cond.kind) {
    case 'contains':
      matched = cond.ignoreCase
        ? text.toLowerCase().includes(value.toLowerCase())
        : text.includes(value);
      break;
    case 'equals':
      matched = cond.ignoreCase ? text.toLowerCase() === value.toLowerCase() : text === value;
      break;
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(value, cond.ignoreCase ? 'i' : undefined);
      } catch (err) {
        // Defensive: validation catches bad regex earlier, but never throw into
        // the engine. A predicate that cannot compile simply never matches.
        console.warn('[edgeConditions] invalid regex predicate; treating as no-match', value, err);
        return false;
      }
      matched = re.test(text);
      break;
    }
    default:
      // Unknown kind: never match (validation drops these with a warning).
      console.warn('[edgeConditions] unknown condition kind; treating as no-match', (cond as { kind?: unknown }).kind);
      return false;
  }

  return cond.negate ? !matched : matched;
}
