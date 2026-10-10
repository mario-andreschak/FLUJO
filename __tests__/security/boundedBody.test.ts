import { readBoundedBody } from '@/utils/http/boundedBody';

test('bounds chunked bodies even without a Content-Length header and cancels the source', async () => {
  const cancel = jest.fn();
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); }, cancel,
  });
  const request = new Request('http://localhost/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  await expect(readBoundedBody(request, 7)).rejects.toThrow('Request body exceeds limit.');
  expect(cancel).toHaveBeenCalledTimes(1);
});

test('returns exactly the admitted bytes without modifying the caller buffer', async () => {
  const bytes = Buffer.from('transient-passphrase');
  const request = new Request('http://localhost/', { method: 'POST', body: bytes });
  expect(await readBoundedBody(request, bytes.length)).toEqual(bytes);
  expect(bytes.toString()).toBe('transient-passphrase');
});
