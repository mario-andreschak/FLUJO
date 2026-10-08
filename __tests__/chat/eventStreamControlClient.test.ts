import { chatService } from '@/frontend/services/chat';
import { EXECUTION_STREAM_CONTROL_EVENT, parseExecutionStreamControl } from '@/shared/types/execution/streamControl';

const control = { version: 1, reason: 'replay-gap', recovery: 'reload-snapshot', nextSeq: 42 };
class Source {
  static latest: Source;
  listeners = new Map<string, EventListener>();
  close = jest.fn();
  onopen: unknown;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: unknown;
  constructor(readonly url: string) { Source.latest = this; }
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener); }
  reset(data: string) { this.listeners.get(EXECUTION_STREAM_CONTROL_EVENT)?.({ data } as unknown as Event); }
}
const original = globalThis.EventSource;
beforeEach(() => { globalThis.EventSource = Source as unknown as typeof EventSource; });
afterAll(() => { globalThis.EventSource = original; });

it.each(['conversation', 'sidebar'])('closes %s before snapshot recovery and keeps controls out of onEvent', kind => {
  const onEvent = jest.fn();
  const onReset = jest.fn(() => { expect(Source.latest.close).toHaveBeenCalledTimes(1); });
  if (kind === 'conversation') chatService.subscribeToEvents('c', { onEvent, onReset }, 0, { activityOnly: true });
  else chatService.subscribeToSidebarEvents({ onEvent, onReset });
  Source.latest.reset(JSON.stringify(control));
  Source.latest.reset(JSON.stringify(control));
  expect(onReset).toHaveBeenCalledTimes(1);
  expect(onReset).toHaveBeenCalledWith(control);
  expect(onEvent).not.toHaveBeenCalled();
  if (kind === 'sidebar') expect(Source.latest.url).toContain('cursorVersion=1');
});

it.each([null, {}, { ...control, version: 2 }, { ...control, nextSeq: -1 }, { ...control, nextSeq: 1.5 }, { ...control, epoch: 'bad:epoch' }])('refuses invalid control %p without closing the event source', value => {
  const onReset = jest.fn(); chatService.subscribeToEvents('c', { onEvent: jest.fn(), onReset });
  Source.latest.reset(JSON.stringify(value));
  expect(parseExecutionStreamControl(value)).toBeUndefined();
  expect(Source.latest.close).not.toHaveBeenCalled(); expect(onReset).not.toHaveBeenCalled();
});

it('preserves normal event bodies and conversation numeric cursor URLs', () => {
  const onEvent = jest.fn(); chatService.subscribeToEvents('c', { onEvent }, 7);
  const event = { type: 'run:start', conversationId: 'c', seq: 7, timestamp: 1, flowId: 'f' };
  Source.latest.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  expect(onEvent).toHaveBeenCalledWith(event);
  expect(Source.latest.url).toContain('fromSeq=7');
  expect(Source.latest.url).not.toContain('cursorVersion');
});
