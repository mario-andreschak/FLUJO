/**
 * Unit tests for buildConversationTitle (issue #134, item 1).
 *
 * The old inline `first-5-words + "..."` produced titles that were both too
 * short and ALWAYS ended in a forced ellipsis. These tests lock in the new
 * behaviour: word + character caps, word-boundary trimming, whitespace
 * normalization, and an ellipsis that appears ONLY when truncation happened.
 */

import {
  buildConversationTitle,
  MAX_TITLE_CHARS,
  DEFAULT_CONVERSATION_TITLE,
} from '@/utils/shared/conversationTitle';

describe('buildConversationTitle', () => {
  it('returns a short message unchanged, with no trailing ellipsis', () => {
    expect(buildConversationTitle('Hello world')).toBe('Hello world');
  });

  it('does not append an ellipsis when exactly at the word cap', () => {
    const ten = 'one two three four five six seven eight nine ten';
    expect(buildConversationTitle(ten)).toBe(ten);
  });

  it('truncates beyond the word cap on a word boundary and appends one ellipsis', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve';
    const title = buildConversationTitle(long);
    expect(title).toBe('one two three four five six seven eight nine ten…');
    expect(title.endsWith('…')).toBe(true);
    // Exactly one ellipsis, never the old literal "..."
    expect(title.includes('...')).toBe(false);
  });

  it('respects the character cap on a word boundary', () => {
    const longWords =
      'supercalifragilistic expialidocious antidisestablishmentarianism pneumonoultramicroscopic';
    const title = buildConversationTitle(longWords);
    // +1 for the appended ellipsis character.
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS + 1);
    expect(title.endsWith('…')).toBe(true);
    // Trimmed on a boundary: no partial trailing word fragment plus a space.
    expect(title).not.toMatch(/ …$/);
  });

  it('collapses runs of whitespace and newlines to single spaces', () => {
    expect(buildConversationTitle('  Hello\n\n  world  ')).toBe('Hello world');
  });

  it('falls back to the default title for empty / whitespace-only input', () => {
    expect(buildConversationTitle('   ')).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(buildConversationTitle('')).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(buildConversationTitle(null)).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(buildConversationTitle(undefined)).toBe(DEFAULT_CONVERSATION_TITLE);
  });
});
