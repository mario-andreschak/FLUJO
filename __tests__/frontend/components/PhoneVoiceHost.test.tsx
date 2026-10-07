import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { NativeVoiceTransport } from '@/vendor/avatar/client/nativeVoiceTransport';

let mockTransport: NativeVoiceTransport;
let mockMounts = 0;
jest.mock('@/frontend/utils/workspaceSelection', () => ({
  ...jest.requireActual('@/frontend/utils/workspaceSelection'),
  getSelectedWorkspace: () => 'worker-fixture', setSelectedWorkspace: jest.fn(), workspacePageUrl: jest.fn(),
  initializeWorkspaceSelection: jest.fn(), readWorkspacePageRequest: () => ({ kind: 'valid', workspace: 'worker-fixture' }),
}));
jest.mock('@/frontend/components/AvatarWorld/index', () => {
  const React = jest.requireActual('react');
  return { __esModule: true, default: ({ voiceTransport }: { voiceTransport: NativeVoiceTransport }) => {
    mockTransport = voiceTransport;
    React.useEffect(() => { mockMounts++; }, []);
    return null;
  } };
});
import PhoneVoiceHost from '@/frontend/components/AvatarWorld/PhoneVoiceHost';
import PhoneHostBoundary from '@/frontend/components/PhoneHostBoundary';

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalFetch = global.fetch;
const originalEncoder = global.TextEncoder;
const originalDecoder = global.TextDecoder;
const session = (scope: string, csrf = 'fixture-csrf') => {
  const data = new TextEncoder().encode(JSON.stringify({ csrf, voiceScopeKey: scope, nativeWorkspace: 'worker-fixture' }));
  let read = false;
  return { ok: true, status: 200, body: { getReader: () => ({
    read: async () => read ? { done: true } : (read = true, { done: false, value: data }),
    cancel: async () => {}, releaseLock: () => {},
  }) } } as unknown as Response;
};

beforeEach(() => {
  mockMounts = 0;
  mockTransport = undefined as unknown as NativeVoiceTransport;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder as typeof global.TextDecoder;
});
afterEach(() => {
  global.fetch = originalFetch;
  global.TextEncoder = originalEncoder; global.TextDecoder = originalDecoder;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
});

test('missing phone session never mounts world work in a default workspace', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 404, body: null } as Response));
  const view = render(<PhoneHostBoundary enabled><PhoneVoiceHost /></PhoneHostBoundary>);
  await act(async () => {});
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(mockMounts).toBe(0);
  view.unmount();
});

test('rotation retires capture scope while preserving the existing world component', async () => {
  let csrf = 'first-csrf';
  global.fetch = jest.fn(async () => session('same-root-scope', csrf));
  const view = render(<PhoneHostBoundary enabled><PhoneVoiceHost /></PhoneHostBoundary>);
  await waitFor(() => expect(mockTransport?.scopeKey).toMatch(/^phone:/));
  const first = mockTransport;
  csrf = 'second-csrf';
  fireEvent.focus(window);
  await waitFor(() => {
    expect(mockTransport?.scopeKey).toMatch(/^phone:/);
    expect(mockTransport.scopeKey).not.toBe(first.scopeKey);
  });
  await expect(first.request('native-reset', { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockMounts).toBe(1);
  view.unmount();
  await expect(mockTransport.request('native-reset', { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'AbortError' });
});

test('an expired availability request disables the binding without touching work ownership', async () => {
  global.fetch = jest.fn(async url => String(url) === '/phone/session' ? session('live-scope')
    : ({ ok: false, status: 401, body: null } as Response));
  const view = render(<PhoneHostBoundary enabled><PhoneVoiceHost /></PhoneHostBoundary>);
  await waitFor(() => expect(mockTransport?.scopeKey).toMatch(/^phone:/));
  await act(async () => { await mockTransport.request('voice', { method: 'GET' }); });
  await waitFor(() => expect(mockMounts).toBe(1));
  await expect(mockTransport.request('native-reset', { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockMounts).toBe(1);
  view.unmount();
});

test('focus during pending admission supersedes the old scope and still mounts the world', async () => {
  let releaseFirst!: (value: ArrayBuffer) => void;
  const delayed = new Promise<ArrayBuffer>(done => { releaseFirst = done; });
  const digest = jest.fn()
    .mockImplementationOnce(() => delayed)
    .mockImplementation((...args: Parameters<typeof webcrypto.subtle.digest>) => webcrypto.subtle.digest(...args));
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest } } });
  global.fetch = jest.fn(async () => session('same-scope'));
  const view = render(<PhoneHostBoundary enabled><PhoneVoiceHost /></PhoneHostBoundary>);
  await waitFor(() => expect(digest).toHaveBeenCalledTimes(1));
  expect(mockMounts).toBe(0);
  fireEvent.focus(window);
  await waitFor(() => expect(mockTransport?.scopeKey).toMatch(/^phone:/));
  await act(async () => { releaseFirst(new ArrayBuffer(32)); });
  await expect(mockTransport.request('native-reset', { method: 'POST', body: '{}' })).resolves.toBeDefined();
  expect(mockMounts).toBe(1);
  expect(global.fetch).toHaveBeenCalledTimes(3);
  view.unmount();
});
