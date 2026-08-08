"use client";

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMediaQuery, useTheme } from '@mui/material';
import { useScrollNav } from '@/frontend/hooks/useScrollNav';
import { useAutoHideOnIdle } from '@/frontend/hooks/useAutoHideOnIdle';
import { resolveScrollBehavior } from '@/frontend/hooks/scrollTarget';
import type { ScrollNavAction } from '@/frontend/components/shared/ScrollNavCluster';

/** px tolerance used to decide "the user is reading the newest message". */
export const CHAT_BOTTOM_TOLERANCE = 80;
/** Chat bubbles double as scroll anchors for "beginning of last message". */
export const CHAT_MESSAGE_ANCHOR_SELECTOR = '[data-ask-flujo-message-id]';

export const CHAT_SCROLL_NAV_ACTIONS: ScrollNavAction[] = ['top', 'up', 'bottom'];

export interface UseChatScrollNavOptions {
  /** Resets the sticky-to-bottom state when the viewed conversation changes. */
  conversationId?: string | null;
  /** Anything that changes when the rendered messages change (array reference is fine). */
  messages?: unknown;
  /** Override the mobile detection (tests / embedded surfaces). */
  autoHideEnabled?: boolean;
  /** Idle delay before the controls fade out on mobile. */
  idleMs?: number;
}

export interface UseChatScrollNavResult {
  /** Spread onto the scrolling messages Box. */
  containerProps: {
    ref: React.RefObject<HTMLDivElement | null>;
    onScroll: () => void;
    onPointerDown: () => void;
  };
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Cluster visibility: reachable from the default bottom position, hidden only when idle on mobile. */
  show: boolean;
  actions: ScrollNavAction[];
  disabled: Partial<Record<ScrollNavAction, boolean>>;
  onAction: (action: ScrollNavAction) => void;
  /** Pin back to the newest message (also used by the composer after sending). */
  jumpToLatest: () => void;
  /** Read-only view of the sticky-autoscroll flag (tests / callers that need it). */
  isPinnedToBottom: () => boolean;
}

/**
 * Chat scroll navigation (#376).
 *
 * Owns the messages scroll container, the sticky-autoscroll flag and the three
 * chat actions: top of the loaded window, beginning of the last message
 * (repeated clicks walk upwards message by message) and back to the newest
 * message. The controls stay reachable while pinned to the bottom — that was
 * the whole point of the issue — and every upward jump clears the sticky flag
 * so an in-flight token stream cannot yank the reader back down.
 */
export function useChatScrollNav(options: UseChatScrollNavOptions = {}): UseChatScrollNavResult {
  const { conversationId, messages, autoHideEnabled, idleMs } = options;

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const autoHide = useAutoHideOnIdle({
    enabled: autoHideEnabled ?? isMobile,
    ...(idleMs === undefined ? {} : { idleMs }),
  });

  const nav = useScrollNav<HTMLDivElement>({
    bottomThreshold: CHAT_BOTTOM_TOLERANCE,
    anchorSelector: CHAT_MESSAGE_ANCHOR_SELECTOR,
    deps: [conversationId, messages],
  });
  const scrollRef = nav.ref;
  const stickToBottomRef = useRef(true);

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: resolveScrollBehavior(behavior) });
      nav.measure();
    },
    [scrollRef, nav],
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceFromBottom < CHAT_BOTTOM_TOLERANCE;
    }
    nav.onScroll();
    autoHide.poke();
  }, [scrollRef, nav, autoHide]);

  const handlePointerDown = useCallback(() => {
    autoHide.poke();
  }, [autoHide]);

  const scrollMessagesToTop = useCallback(() => {
    stickToBottomRef.current = false;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: 0, behavior: resolveScrollBehavior('smooth') });
    nav.measure();
  }, [scrollRef, nav]);

  const scrollToLastMessageStart = useCallback(() => {
    stickToBottomRef.current = false;
    nav.scrollToPreviousAnchor();
  }, [nav]);

  const jumpToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    scrollMessagesToBottom('smooth');
  }, [scrollMessagesToBottom]);

  const onAction = useCallback(
    (action: ScrollNavAction) => {
      autoHide.poke();
      if (action === 'top') scrollMessagesToTop();
      else if (action === 'up') scrollToLastMessageStart();
      else if (action === 'bottom') jumpToLatest();
    },
    [autoHide, scrollMessagesToTop, scrollToLastMessageStart, jumpToLatest],
  );

  // Re-pin whenever the viewed conversation changes.
  useEffect(() => {
    stickToBottomRef.current = true;
    scrollMessagesToBottom('auto');
     
  }, [conversationId]);

  // Keep pinned as messages change — new messages AND in-place streaming
  // updates — but only while the user has not scrolled up.
  useEffect(() => {
    if (stickToBottomRef.current) scrollMessagesToBottom('auto');
     
  }, [messages]);

  const disabled = useMemo<Partial<Record<ScrollNavAction, boolean>>>(
    () => ({ top: nav.atTop, up: nav.atTop, bottom: nav.atBottom }),
    [nav.atTop, nav.atBottom],
  );

  return {
    containerProps: { ref: scrollRef, onScroll: handleScroll, onPointerDown: handlePointerDown },
    scrollRef,
    // Visible whenever the transcript can scroll at all: from the default
    // bottom position the user must still be able to reach "scroll to top".
    show: nav.scrollable && autoHide.visible,
    actions: CHAT_SCROLL_NAV_ACTIONS,
    disabled,
    onAction,
    jumpToLatest,
    isPinnedToBottom: () => stickToBottomRef.current,
  };
}

export default useChatScrollNav;
