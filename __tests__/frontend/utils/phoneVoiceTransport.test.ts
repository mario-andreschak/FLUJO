import { createPhoneVoiceTransport, parsePhoneVoiceSession, readPhoneVoiceSession } from '@/frontend/components/AvatarWorld/phoneVoiceTransport';

const session = { csrf: 'fixture-csrf', voiceScopeKey: 'owner-session:workspace:revision', nativeWorkspace: 'worker-fixture' };

test('phone voice uses fixed relative BFF routes and captures public session data only', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = jest.fn(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response('{}');
  }) as typeof fetch;
  const transport = await createPhoneVoiceTransport(session, new AbortController().signal, jest.fn(), fetcher);
  await transport.request('voice', { method: 'GET' });
  await transport.request('native-reset', { method: 'POST', body: '{}', headers: {
    'x-flujo-avatar-client': 'fixture-client', authorization: 'must-not-forward',
    'x-flujo-avatar-authorization': 'must-not-forward', 'x-flujo-workspace': 'caller-workspace',
    'x-phone-csrf': 'caller-csrf',
  } });
  expect(calls.map(call => call.url)).toEqual(['/phone/voice/availability', '/phone/voice/native-reset']);
  const headers = new Headers(calls[1].init.headers);
  expect(headers.get('x-phone-csrf')).toBe(session.csrf);
  expect(headers.get('x-flujo-avatar-client')).toBe('fixture-client');
  expect(headers.has('authorization')).toBe(false);
  expect(headers.has('x-flujo-avatar-authorization')).toBe(false);
  expect(headers.has('x-flujo-workspace')).toBe(false);
  expect(calls[1].init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: '{}' });
  expect(transport.workletUrl).toBe('/avatar-audio-capture.js');
  expect(transport.scopeKey).not.toContain(session.csrf);
  expect(Object.isFrozen(transport)).toBe(true);
});

test('scope identity changes for server scope and CSRF rotation', async () => {
  const factory = (value: typeof session) => createPhoneVoiceTransport(value, new AbortController().signal, jest.fn());
  const first = await factory(session);
  expect((await factory({ ...session })).scopeKey).toBe(first.scopeKey);
  expect((await factory({ ...session, csrf: 'rotated-csrf' })).scopeKey).not.toBe(first.scopeKey);
  expect((await factory({ ...session, voiceScopeKey: 'different-owner' })).scopeKey).not.toBe(first.scopeKey);
  expect((await factory({ ...session, nativeWorkspace: 'different-workspace' })).scopeKey).not.toBe(first.scopeKey);
});

test('a retired scope cancels late responses and never retries a POST', async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const fetcher = jest.fn(() => pending) as typeof fetch;
  const lifetime = new AbortController();
  const transport = await createPhoneVoiceTransport(session, lifetime.signal, jest.fn(), fetcher);
  const request = transport.request('native-turn', { method: 'POST', body: '{}' });
  lifetime.abort();
  let cancelled = false;
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled).toBe(true);
  await expect(transport.request('native-reset', { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('denied admission retires the host and wrong actions or methods never reach fetch', async () => {
  const denied = jest.fn();
  const fetcher = jest.fn(async () => new Response('{}', { status: 403 })) as typeof fetch;
  const transport = await createPhoneVoiceTransport(session, new AbortController().signal, denied, fetcher);
  await transport.request('native-input', { method: 'POST', body: '{}' });
  expect(denied).toHaveBeenCalledTimes(1);
  await expect(transport.request('voice', { method: 'POST' })).rejects.toThrow('phone_voice_method_unavailable');
  await expect(transport.request('other' as 'voice', { method: 'GET' })).rejects.toThrow('phone_voice_action_unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('session DTO refuses missing admission, header injection and unbounded data', async () => {
  expect(() => parsePhoneVoiceSession({ csrf: 'fixture' })).toThrow();
  expect(() => parsePhoneVoiceSession({ ...session, csrf: 'bad\r\nheader' })).toThrow();
  expect(parsePhoneVoiceSession({ ...session, ignored: 'not-authority' })).toEqual(session);
  await expect(readPhoneVoiceSession(new Response('{}', { status: 401 }))).rejects.toThrow();
  await expect(readPhoneVoiceSession(new Response('x'.repeat(8193)))).rejects.toThrow();
});
