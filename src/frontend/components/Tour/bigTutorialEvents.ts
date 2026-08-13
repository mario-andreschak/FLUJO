export const BIG_TUTORIAL_EVENT = 'flujo:big-tutorial';

export type BigTutorialEventDetail =
  | { type: 'conversation-created'; conversationId: string }
  | { type: 'chat-run-status'; status: 'running' | 'completed' | 'error' }
  | { type: 'app-connected'; serverName: string }
  | { type: 'send-example'; message: string }
  | { type: 'open-chat-flow-picker'; query: string }
  | { type: 'prepare-app-picker'; processNodeId: string; query: string }
  | { type: 'open-app-marketplace' }
  | { type: 'filter-agent-search'; query: string }
  | { type: 'filter-app-picker'; query: string };

export function emitBigTutorialEvent(detail: BigTutorialEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<BigTutorialEventDetail>(BIG_TUTORIAL_EVENT, { detail }));
}

export function isBigTutorialEvent(event: Event): event is CustomEvent<BigTutorialEventDetail> {
  return event instanceof CustomEvent && !!event.detail && typeof event.detail.type === 'string';
}
