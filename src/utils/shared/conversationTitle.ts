/**
 * Shared helper for deriving a conversation's display title from its first user
 * message (issue #134, item 1).
 *
 * It replaces the old inline
 *   `firstUserMessage.content.split(' ').slice(0, 5).join(' ') + '...'`
 * used at four sites in `runFlow.ts`, which produced titles that were both too
 * short (a hard 5-word cap) AND always ended in a forced "..." even when nothing
 * had actually been truncated.
 *
 * The new title:
 *  - collapses runs of whitespace/newlines to single spaces and trims,
 *  - keeps up to `MAX_TITLE_WORDS` words and `MAX_TITLE_CHARS` characters,
 *  - trims on a word boundary when the character cap bites,
 *  - only appends a single ellipsis ("…") when the source was actually
 *    truncated (so short messages read as clean, complete titles).
 *
 * Kept free of any React/Node dependency so it can be shared by the backend
 * (`runFlow`) and unit-tested in the node-env Jest harness.
 */

/** Maximum number of words kept from the first user message. */
export const MAX_TITLE_WORDS = 10;
/** Maximum number of characters kept (excluding the appended ellipsis). */
export const MAX_TITLE_CHARS = 60;
/** Appended only when the title was actually truncated. */
export const TITLE_ELLIPSIS = '…';
/** Fallback used when there is no usable text. */
export const DEFAULT_CONVERSATION_TITLE = 'New Conversation';

/**
 * Build a clean, human-readable conversation title from the first user message.
 * Returns {@link DEFAULT_CONVERSATION_TITLE} when the input is empty/whitespace.
 */
export function buildConversationTitle(firstUserMessage: string | null | undefined): string {
  const normalized = (firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return DEFAULT_CONVERSATION_TITLE;

  let candidate = normalized;
  let truncated = false;

  // 1. Word cap.
  const words = candidate.split(' ');
  if (words.length > MAX_TITLE_WORDS) {
    candidate = words.slice(0, MAX_TITLE_WORDS).join(' ');
    truncated = true;
  }

  // 2. Character cap, trimmed to a word boundary where possible.
  if (candidate.length > MAX_TITLE_CHARS) {
    const clipped = candidate.slice(0, MAX_TITLE_CHARS);
    const lastSpace = clipped.lastIndexOf(' ');
    candidate = (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
    truncated = true;
  }

  return truncated ? `${candidate}${TITLE_ELLIPSIS}` : candidate;
}
