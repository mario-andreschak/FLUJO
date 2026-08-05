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
  isDefaultConversationTitle,
  MAX_TITLE_CHARS,
  DEFAULT_CONVERSATION_TITLE,
} from '@/utils/shared/conversationTitle';
import { chatMessageRows } from '@/frontend/i18n/catalogs/chat';

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

describe('isDefaultConversationTitle', () => {
  it('recognizes the canonical backend default', () => {
    expect(isDefaultConversationTitle(DEFAULT_CONVERSATION_TITLE)).toBe(true);
  });

  it('recognizes the English UI placeholder with its lowercase "c" (the regression)', () => {
    // The i18n pass changed the seeded title from 'New Conversation' to
    // 'New conversation'; the strict `=== 'New Conversation'` gate then never
    // matched and every chat kept the placeholder title.
    expect(isDefaultConversationTitle('New conversation')).toBe(true);
  });

  it('recognizes every localized chat.page.newTitle variant', () => {
    // Guard against locale drift: any newly added/changed translation of the
    // "new conversation" label must also be accepted by the auto-title gate.
    const localized = chatMessageRows['chat.page.newTitle'];
    expect(localized.length).toBeGreaterThan(1);
    for (const label of localized) {
      expect(isDefaultConversationTitle(label)).toBe(true);
    }
  });

  it('treats empty / whitespace-only titles as untitled', () => {
    expect(isDefaultConversationTitle('')).toBe(true);
    expect(isDefaultConversationTitle('   ')).toBe(true);
    expect(isDefaultConversationTitle(null)).toBe(true);
    expect(isDefaultConversationTitle(undefined)).toBe(true);
  });

  it('never clobbers a real or user-renamed title', () => {
    expect(isDefaultConversationTitle('New conversation about billing')).toBe(false);
    expect(isDefaultConversationTitle('Deploy checklist')).toBe(false);
    expect(isDefaultConversationTitle(buildConversationTitle('why is my flow stuck'))).toBe(false);
  });
});
