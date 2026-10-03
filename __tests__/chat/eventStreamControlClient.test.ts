import { chatService } from '@/frontend/services/chat';
import { EXECUTION_STREAM_CONTROL_EVENT } from '@/shared/types/execution/streamControl';

class FakeEventSource extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = jest.fn();
  constructor(readonly url: string) { super(); }
}
const original = globalThis.EventSource;
beforeEach(() => { Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: FakeEventSource }); });
afterAll(() => { Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: original }); });

it.each(['conversation', 'sidebar'] as const)('closes %s before snapshot recovery and does not dispatch a control as an execution event', mode => {
  const onEvent = jest.fn();
  let source!: FakeEventSource;
  const onReset = jest.fn(() => expect(source.close).toHaveBeenCalledTimes(1));
  source = (mode === 'sidebar' ? chatService.subscribeToSidebarEvents({ onEvent, onReset }) : chatService.subscribeToEvents('conv', { onEvent, onReset })) as unknown as FakeEventSource;
  const control = { version: 1, reason: 'replay-gap', recovery: 'reload-snapshot', nextSeq: 4 };
  source.dispatchEvent(new MessageEvent(EXECUTION_STREAM_CONTROL_EVENT, { data: JSON.stringify(control) }));
  expect(onReset).toHaveBeenCalledWith(control);
  expect(onEvent).not.toHaveBeenCalled();
});

it('ignores malformed control and preserves ordinary execution payloads', () => {
  const onEvent = jest.fn(); const onReset = jest.fn();
  const source = chatService.subscribeToEvents('conv', { onEvent, onReset }) as unknown as FakeEventSource;
  source.dispatchEvent(new MessageEvent(EXECUTION_STREAM_CONTROL_EVENT, { data: '{"version":8}' }));
  expect(onReset).not.toHaveBeenCalled(); expect(source.close).not.toHaveBeenCalled();
  const event = { type: 'run:done', conversationId: 'conv', seq: 2, timestamp: 1, status: 'completed' };
  source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  expect(onEvent).toHaveBeenCalledWith(event);
});
