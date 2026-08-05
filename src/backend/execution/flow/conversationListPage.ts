import type { ConversationSummary } from './conversationSummaryStore';

const CURSOR_VERSION = 1;

interface ConversationPageCursor {
  v: typeof CURSOR_VERSION;
  activityAt: number;
  id: string;
}

export interface ConversationListPage<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

export class ConversationCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationCursorError';
  }
}

export const conversationActivityAt = (
  conversation: Pick<ConversationSummary, 'lastUserMessageAt' | 'updatedAt'>,
): number => conversation.lastUserMessageAt ?? conversation.updatedAt;

export function compareConversationActivity(
  left: Pick<ConversationSummary, 'id' | 'lastUserMessageAt' | 'updatedAt'>,
  right: Pick<ConversationSummary, 'id' | 'lastUserMessageAt' | 'updatedAt'>,
): number {
  return conversationActivityAt(right) - conversationActivityAt(left) || left.id.localeCompare(right.id);
}

function encodeCursor(cursor: ConversationPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): ConversationPageCursor {
  if (!raw || raw.length > 512) {
    throw new ConversationCursorError('cursor must be a non-empty cursor returned by a previous request');
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ConversationPageCursor>;
    if (
      parsed.v !== CURSOR_VERSION
      || typeof parsed.activityAt !== 'number'
      || !Number.isFinite(parsed.activityAt)
      || typeof parsed.id !== 'string'
      || parsed.id.length === 0
    ) {
      throw new Error('invalid cursor payload');
    }
    return parsed as ConversationPageCursor;
  } catch {
    throw new ConversationCursorError('cursor is invalid or malformed');
  }
}

/**
 * Stable keyset pagination for the activity-descending sidebar. Unlike an
 * offset cursor, inserting a new conversation at the top between requests does
 * not duplicate or skip older rows.
 */
export function paginateConversationSummaries<T extends ConversationSummary>(
  conversations: T[],
  limit: number,
  rawCursor?: string,
): ConversationListPage<T> {
  const sorted = [...conversations].sort(compareConversationActivity);
  const cursor = rawCursor ? decodeCursor(rawCursor) : undefined;
  const afterCursor = cursor
    ? sorted.filter((conversation) => {
        const activityAt = conversationActivityAt(conversation);
        return activityAt < cursor.activityAt
          || (activityAt === cursor.activityAt && conversation.id.localeCompare(cursor.id) > 0);
      })
    : sorted;
  const items = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > items.length;
  const last = items[items.length - 1];
  return {
    items,
    total: sorted.length,
    hasMore,
    ...(hasMore && last
      ? {
          nextCursor: encodeCursor({
            v: CURSOR_VERSION,
            activityAt: conversationActivityAt(last),
            id: last.id,
          }),
        }
      : {}),
  };
}
