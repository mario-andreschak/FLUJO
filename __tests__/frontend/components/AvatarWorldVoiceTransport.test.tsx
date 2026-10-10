import { createRef, type ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Render the host itself. Scene, embedded panels, work execution and audio are
// explicit substitutes; this suite qualifies transport handoff, not inference.
jest.mock('@/frontend/components/AvatarWorld/WorldScene', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/AvatarWorld/Eyes', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/AvatarWorld/Watershed', () => ({
  __esModule: true, default: () => null, PLACE_ROUTES: {}, PLACE_KINDS: {}, LANDMARK_POSITIONS: {},
}));
jest.mock('@/frontend/components/AvatarWorld/ConnectionSetup', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/AvatarWorld/ResourcePreview', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Navigation/QuickActionsMenu', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/AvatarWorld/WorldLink', () => ({ __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('react-markdown', () => ({ __esModule: true, default: ({ children }: { children: ReactNode }) => <>{children}</> }));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => {} }));
jest.mock('@/frontend/contexts/I18nContext', () => {
  const setLocale = jest.fn();
  return { useI18n: () => ({ setLocale }) };
});
jest.mock('@/frontend/components/AvatarWorld/useAvatarWork', () => ({ useAvatarWork: jest.fn() }));
jest.mock('@/frontend/components/AvatarWorld/useWorldPanel', () => ({ useWorldPanel: jest.fn() }));
jest.mock('@flujo-ai/avatar-sdk/native-voice', () => ({
  DEFAULT_LOCALE: 'en',
  usePocketSpeech: jest.requireActual('@flujo-ai/avatar-sdk/native-voice').usePocketSpeech,
  useNativeRouterVoice: jest.fn(),
  voiceHeaders: () => ({ 'Content-Type': 'application/json', 'x-flujo-avatar-client': '00000000-0000-4000-8000-000000000001' }),
}));

import AvatarWorld from '@/frontend/components/AvatarWorld';
import { useAvatarWork } from '@/frontend/components/AvatarWorld/useAvatarWork';
import { useWorldPanel } from '@/frontend/components/AvatarWorld/useWorldPanel';
import { useNativeRouterVoice, type NativeVoiceTransport } from '@flujo-ai/avatar-sdk/native-voice';
import type { AvatarWorldSnapshot } from '@/shared/types/avatar';

const snapshot: AvatarWorldSnapshot = { checkedAt: 1, workModel: { modelId: 'model', label: 'My AI', verifiedAt: 1, ready: true },
  objects: [], unavailable: [], truncated: [] };
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function frozenTransport(scopeKey: string, request: NativeVoiceTransport['request']): NativeVoiceTransport {
  return Object.freeze({ scopeKey, workletUrl: '/host-owned-capture.js', request });
}

let work: ReturnType<typeof useAvatarWork>;
let voice: ReturnType<typeof useNativeRouterVoice>;
let fetchMock: jest.Mock;
let currentTransport: NativeVoiceTransport | undefined;
const firstOwner = Symbol('first mounted voice session');
const secondOwner = Symbol('second mounted voice session');
const originalFetch = global.fetch;
const originalMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

beforeEach(() => {
  jest.clearAllMocks(); window.localStorage.clear();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: jest.fn(() => ({ matches: false })) });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: jest.fn() });
  work = {
    conversation: { id: 'conversation', title: 'World', flowId: 'quickchat-conversation', createdAt: 1, updatedAt: 2,
      status: 'completed', messages: [{ id: 'reply', timestamp: 1, role: 'assistant', content: 'Five.' }] },
    target: { kind: 'guide' }, messages: [{ id: 'reply', role: 'assistant', text: 'Five.' }],
    phase: 'idle', busy: false, error: null, activity: null, send: jest.fn(async () => true),
    stop: jest.fn(async () => {}), newChat: jest.fn(() => true),
  };
  voice = { connected: true, connecting: false, hasMicrophone: false, phase: 'idle', muted: false, error: '', audioLevel: 0,
    connect: jest.fn(async () => {}), disconnect: jest.fn(), interrupt: jest.fn(), toggleMute: jest.fn(),
    sendText: jest.fn(() => true), sendTaskResult: jest.fn(() => true),
    getSessionOwner: jest.fn(() => currentTransport?.scopeKey === 'scope-b' ? secondOwner : firstOwner),
    resetAccountContext: jest.fn(), setPersona: jest.fn(), clearError: jest.fn(),
  };
  currentTransport = undefined;
  jest.mocked(useAvatarWork).mockImplementation(() => work);
  jest.mocked(useNativeRouterVoice).mockImplementation(options => { currentTransport = options.transport; return voice; });
  jest.mocked(useWorldPanel).mockReturnValue({ iframeRef: createRef<HTMLIFrameElement>(), src: null, open: false,
    navigate: jest.fn(), close: jest.fn(), context: async () => null,
    apply: async () => ({ success: false, message: 'Unused panel fixture' }),
  });
  fetchMock = jest.fn(async (url: string) => {
    if (url === '/api/avatar/world') return response(snapshot);
    if (url === '/api/avatar/voice') return response({ available: true });
    throw new Error('Unexpected host fixture request');
  });
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalMedia) Object.defineProperty(window, 'matchMedia', originalMedia); else Reflect.deleteProperty(window, 'matchMedia');
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScroll); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});

test('injected transport handles availability and a canonical receipt across an unchanged-result refresh', async () => {
  const receipt = deferred<Response>();
  const request = jest.fn(async (endpoint: Parameters<NativeVoiceTransport['request']>[0], _init: RequestInit) =>
    endpoint === 'voice' ? response({ available: true }) : receipt.promise);
  const transport = frozenTransport('scope-a', request);
  const { rerender } = render(<AvatarWorld voiceTransport={transport} />);
  await waitFor(() => expect(request).toHaveBeenCalledWith('voice', expect.objectContaining({ method: 'GET' })));
  await waitFor(() => expect(request).toHaveBeenCalledWith('native-result-receipt', expect.objectContaining({ method: 'POST' })));
  expect(jest.mocked(useNativeRouterVoice).mock.calls.at(-1)![0].transport).toBe(transport);
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/avatar/voice' || url === '/api/avatar/native-result-receipt')).toBe(false);
  const pending = request.mock.calls.find(([endpoint]) => endpoint === 'native-result-receipt')![1];
  expect(JSON.parse(String(pending.body))).toEqual({ conversationId: 'conversation', messageId: 'reply', locale: 'en' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Talk' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Explore my world' }));
  // A canonical refresh recreates projection objects without changing the reply.
  work = { ...work, conversation: { ...work.conversation!, updatedAt: 3 }, messages: work.messages.map(message => ({ ...message })) };
  rerender(<AvatarWorld voiceTransport={transport} />);
  await act(async () => { receipt.resolve(response({ taskId: 'current-result' })); });
  expect(voice.sendTaskResult).toHaveBeenCalledTimes(1);
  expect(voice.sendTaskResult).toHaveBeenCalledWith('current-result', firstOwner);
  expect(request.mock.calls.filter(([endpoint]) => endpoint === 'native-result-receipt')).toHaveLength(1);
});

test('a changed transport scope aborts and ignores delayed old availability and narration receipts', async () => {
  const availability = deferred<Response>(), receipt = deferred<Response>();
  const oldRequest = jest.fn(async (endpoint: Parameters<NativeVoiceTransport['request']>[0], _init: RequestInit) =>
    endpoint === 'voice' ? availability.promise : receipt.promise);
  const newRequest = jest.fn(async (_endpoint: Parameters<NativeVoiceTransport['request']>[0], _init: RequestInit) => response({ available: false }));
  const oldTransport = frozenTransport('scope-a', oldRequest), newTransport = frozenTransport('scope-b', newRequest);
  const { rerender } = render(<AvatarWorld voiceTransport={oldTransport} />);
  await waitFor(() => expect(oldRequest).toHaveBeenCalledTimes(2));
  const oldAvailability = oldRequest.mock.calls.find(([endpoint]) => endpoint === 'voice')![1];
  const oldReceipt = oldRequest.mock.calls.find(([endpoint]) => endpoint === 'native-result-receipt')![1];
  // The audio hook's independent scope-change tests cover its disconnect; here
  // the host observes that disconnected hook state during the new render.
  voice = { ...voice, connected: false };
  rerender(<AvatarWorld voiceTransport={newTransport} />);
  await waitFor(() => expect(newRequest).toHaveBeenCalledWith('voice', expect.objectContaining({ method: 'GET' })));
  expect(oldAvailability.signal?.aborted).toBe(true);
  expect(oldReceipt.signal?.aborted).toBe(true);
  expect(jest.mocked(useNativeRouterVoice).mock.calls.at(-1)![0].transport).toBe(newTransport);
  await act(async () => {
    availability.resolve(response({ available: true })); receipt.resolve(response({ taskId: 'old-result' }));
  });
  expect(screen.getByRole('button', { name: 'Talk' })).toBeDisabled();
  expect(voice.sendTaskResult).not.toHaveBeenCalled();
  expect(newRequest.mock.calls.map(([endpoint]) => endpoint)).toEqual(['voice']);
});

test('omitting the transport preserves the original local voice availability path', async () => {
  work = { ...work, conversation: null, messages: [] };
  voice = { ...voice, connected: false };
  render(<AvatarWorld />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/avatar/voice', expect.objectContaining({ method: 'GET' })));
  expect(jest.mocked(useNativeRouterVoice).mock.calls.at(-1)![0].transport).toBeUndefined();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Talk' })).toBeEnabled());
});
