import { getHeapStatistics } from 'node:v8';
import { NextRequest } from 'next/server';
import { acquireChatIngress, acquireChatIngressWhenAvailable, CHAT_INGRESS_LIMITS, claimChatIngress, finishChatInputParsing,
  getChatIngressDiagnostics } from '@/utils/http/chatIngress';
import { parseRequestParameters } from '@/app/v1/chat/completions/requestParser';
import { getAllocationReservationSnapshot, pendingAllocationBytes, setAllocationReservation } from '@/backend/execution/flow/allocationReservations';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
const url = 'http://localhost/v1/chat/completions';
function request(body: string, length?: string) {
  return new NextRequest(url, { method: 'POST', body, headers: length ? { 'content-length': length } : undefined });
}
afterEach(() => {
  jest.restoreAllMocks();
  expect(getChatIngressDiagnostics()).toMatchObject({ active: 0, parsing: 0, reservedBytes: 0 });
});

it.each([2_000_000, 5_600_000])('accepts an exact %i character history plus 64KiB media without truncation', async size => {
  const content = 'a'.repeat(size);
  const media = `data:image/png;base64,${Buffer.alloc(64 * 1024, 7).toString('base64')}`;
  const parsed = await parseRequestParameters(request(JSON.stringify({ model: 'flow-test', messages: [
    { role: 'user', content }, { role: 'user', content: [{ type: 'image_url', image_url: { url: media } }] },
  ] })));
  expect(parsed.messages[0].content).toBe(content);
  expect(parsed.messages[1].content).toEqual([{ type: 'image_url', image_url: { url: media } }]);
});

it('refuses declared oversize before acquiring a body reader or parsing', async () => {
  const req = request('{}', String(CHAT_INGRESS_LIMITS.bodyBytes + 1));
  const reader = jest.spyOn(req.body!, 'getReader');
  const parse = jest.spyOn(JSON, 'parse');
  await expect(parseRequestParameters(req)).rejects.toMatchObject({ status: 413 });
  expect(reader).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
});

it.each([undefined, '1'])('refuses oversized actual chunked input before decoding, despite content-length %s', async length => {
  let pulls = 0;
  const cancel = jest.fn();
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    pulls++;
    controller.enqueue(new Uint8Array(CHAT_INGRESS_LIMITS.bodyBytes / 2 + 1));
  }, cancel });
  const req = new NextRequest(url, { method: 'POST', body, duplex: 'half', headers: length ? { 'content-length': length } : undefined } as ConstructorParameters<typeof NextRequest>[1]);
  const decode = jest.spyOn(TextDecoder.prototype, 'decode');
  const parse = jest.spyOn(JSON, 'parse');
  await expect(parseRequestParameters(req)).rejects.toMatchObject({ code: 'CHAT_INPUT_TOO_LARGE' });
  expect(decode).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1); expect(pulls).toBeLessThanOrEqual(3);
});

it.each([
  ['depth', '{"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}'],
  ['values', '{"x":[' + '0,'.repeat(100_001) + '0]}'],
])('bounds %s before JSON.parse', async (_name, body) => {
  const req = request(body);
  const parse = jest.spyOn(JSON, 'parse');
  await expect(parseRequestParameters(req)).rejects.toMatchObject({ status: 413 });
  expect(parse).not.toHaveBeenCalled();
});

it('classifies malformed JSON without exposing private source', async () => {
  await expect(parseRequestParameters(request('{"private-secret": nope}'))).rejects.toMatchObject({ status: 400, code: 'CHAT_INPUT_INVALID' });
  try { await parseRequestParameters(request('{"private-secret": nope}')); }
  catch (error) { expect(String(error)).not.toContain('private-secret'); }
});

it('does not fall back to unbounded json methods on incomplete mock requests', async () => {
  const json = jest.fn().mockResolvedValue({});
  await expect(parseRequestParameters({ method: 'POST', url, headers: new Headers(), json } as unknown as NextRequest)).rejects.toMatchObject({ status: 400 });
  expect(json).not.toHaveBeenCalled();
});

it('holds capacity for two slow body readers, rejects a third without acquiring its reader, then drains on abort', async () => {
  const controls = [new AbortController(), new AbortController()];
  const requests = controls.map(controller => new NextRequest(url, { method: 'POST',
    signal: controller.signal, body: new ReadableStream({}), duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]));
  const running = requests.map(req => parseRequestParameters(req).catch(error => error));
  expect(getChatIngressDiagnostics()).toMatchObject({ active: 2, parsing: 2 });
  const refused = request('{}'); const getReader = jest.spyOn(refused.body!, 'getReader');
  await expect(parseRequestParameters(refused)).rejects.toMatchObject({ status: 429 });
  expect(getReader).not.toHaveBeenCalled();
  controls.forEach(controller => controller.abort());
  expect(await Promise.all(running)).toEqual([expect.objectContaining({ code: 'CHAT_INPUT_ABORTED' }), expect.objectContaining({ code: 'CHAT_INPUT_ABORTED' })]);
});

it('holds retained source bytes and independent producer ownership after route release', async () => {
  const raw = ' '.repeat(2_000_000) + '{"model":"model-test","messages":[]}';
  const req = request(raw); const permit = acquireChatIngress(req);
  await parseRequestParameters(req, permit);
  expect(getChatIngressDiagnostics().reservedBytes).toBeGreaterThanOrEqual(raw.length * 2);
  const owner = claimChatIngress(permit); const producerDone = owner.retain();
  expect(() => claimChatIngress(permit)).toThrow('twice');
  permit.release(); owner.release();
  expect(() => owner.retain()).toThrow('expired');
  expect(getChatIngressDiagnostics().active).toBe(1);
  producerDone(); producerDone();
});

it('keeps aborted input charged until the first underlying cancellation actually settles', async () => {
  const controller = new AbortController();
  let cancelled!: () => void;
  const body = new ReadableStream({ cancel: () => new Promise<void>(resolve => { cancelled = resolve; }) });
  const req = new NextRequest(url, { method: 'POST', signal: controller.signal, body, duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]);
  const pending = parseRequestParameters(req).catch(error => error);
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  expect(getChatIngressDiagnostics()).toMatchObject({ active: 1, parsing: 1 });
  cancelled();
  await expect(pending).resolves.toMatchObject({ code: 'CHAT_INPUT_ABORTED' });
});

it('cancels a stalled body at the declared deadline', async () => {
  jest.useFakeTimers();
  try {
    const req = new NextRequest(url, { method: 'POST', body: new ReadableStream({}), duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]);
    const pending = parseRequestParameters(req).catch(error => error);
    jest.advanceTimersByTime(CHAT_INGRESS_LIMITS.bodyTimeoutMs);
    await expect(pending).resolves.toMatchObject({ code: 'CHAT_INPUT_ABORTED' });
  } finally { jest.useRealTimers(); }
});

it('keeps admitting input while many earlier chats hold their parsed charge, and rejects forged permits', () => {
  const permits = Array.from({ length: CHAT_INGRESS_LIMITS.owners }, () => {
    const permit = acquireChatIngress(request('{}')); finishChatInputParsing(permit, 2, 1); return permit;
  });
  try {
    // Long-running chats no longer exhaust a fixed number of input slots.
    const next = acquireChatIngress(request('{}'));
    next.release();
    expect(() => claimChatIngress({ release() {} })).toThrow('invalid');
  } finally { permits.forEach(permit => permit.release()); }
});

it('bounds concurrent parsing by its byte reservation', () => {
  const parsing: ReturnType<typeof acquireChatIngress>[] = [];
  try {
    for (;;) parsing.push(acquireChatIngress(request('{}')));
  } catch (error) {
    expect(error).toMatchObject({ code: 'CHAT_INPUT_BUSY' });
  } finally { parsing.forEach(permit => permit.release()); }
  expect(parsing.length).toBeGreaterThan(0);
  expect(parsing.length).toBeLessThanOrEqual(CHAT_INGRESS_LIMITS.owners);
});

it('waits for parsing capacity instead of refusing a momentarily busy server', async () => {
  const parsing: ReturnType<typeof acquireChatIngress>[] = [];
  try { for (;;) parsing.push(acquireChatIngress(request('{}'))); } catch { /* full */ }
  const waiting = acquireChatIngressWhenAvailable(request('{}'), 5_000);
  setTimeout(() => parsing.shift()?.release(), 50);
  const permit = await waiting;
  permit.release();
  parsing.forEach(held => held.release());
  // Size errors are never waited on.
  await expect(acquireChatIngressWhenAvailable({ method: 'GET', url: 'x'.repeat(CHAT_INGRESS_LIMITS.urlCharacters + 1), headers: new Headers() }, 5_000))
    .rejects.toMatchObject({ code: 'CHAT_INPUT_TOO_LARGE' });
});

it('bounds GET raw URL and parameter count before URL decoding while accepting the reference history', async () => {
  const parsed = await parseRequestParameters(new NextRequest(`${url}?model=model-test&message=${'a'.repeat(5_600_000)}`));
  expect(parsed.messages[0].content).toHaveLength(5_600_000);
  await expect(parseRequestParameters(new NextRequest(`${url}?${'x=1&'.repeat(129)}`))).rejects.toMatchObject({ status: 413 });
  await expect(parseRequestParameters({ method: 'GET', url: 'x'.repeat(CHAT_INGRESS_LIMITS.urlCharacters + 1), headers: new Headers() } as NextRequest)).rejects.toMatchObject({ status: 413 });
});

it('observes fixed shared reservations before allocating and does not mutate failed observations', () => {
  // Larger than the whole heap: refused by heap headroom on any machine size.
  setAllocationReservation('output', getHeapStatistics().heap_size_limit);
  try {
    const snapshot = getAllocationReservationSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(pendingAllocationBytes('ingress', 123)).toBe(snapshot.total + 123);
    expect(() => acquireChatIngress(request('{}'))).toThrow('memory');
    expect(() => setAllocationReservation('unknown' as 'run', 1)).toThrow('Invalid');
    expect(() => setAllocationReservation('run', NaN)).toThrow('Invalid');
    expect(getAllocationReservationSnapshot()).toEqual(snapshot);
  } finally { setAllocationReservation('output', 0); }
});

it('preserves live reservations and opaque claims across another module instance', () => {
  const permit = acquireChatIngress(request('{}'));
  finishChatInputParsing(permit, 2, 1);
  let another!: typeof import('@/utils/http/chatIngress');
  jest.isolateModules(() => { another = require('@/utils/http/chatIngress'); });
  const owner = another.claimChatIngress(permit);
  permit.release();
  expect(another.getChatIngressDiagnostics().active).toBe(1);
  owner.release();
});
