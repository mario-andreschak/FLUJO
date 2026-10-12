import http from 'node:http';
import http2 from 'node:http2';
import { registryGetRaw } from '@/backend/utils/registryClient';

describe('Registry discovery transport bounds', () => {
  it('limits actual HTTP/2 UTF-8 bytes and closes the owned connection without fallback', async () => {
    const server = http2.createServer();
    server.on('stream', stream => { stream.respond({ ':status': 200 }); stream.end('é'.repeat(60)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const fetch = jest.spyOn(global, 'fetch');
    try {
      await expect(registryGetRaw(new URL(`http://127.0.0.1:${address.port}/servers`), 1000, { maxBytes: 100 })).rejects.toThrow('byte limit');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('uses an absolute HTTP/2 deadline even while a peer keeps sending data', async () => {
    const server = http2.createServer();
    let timer: ReturnType<typeof setInterval> | undefined;
    server.on('stream', stream => {
      stream.respond({ ':status': 200 });
      timer = setInterval(() => { if (!stream.destroyed) stream.write('x'); }, 10);
      stream.on('close', () => clearInterval(timer));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const fetch = jest.spyOn(global, 'fetch');
    // Keep real timers and traffic, but force elapsed wall time to remain below
    // the deadline: a terminal timeout must never depend on clock rounding.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await expect(registryGetRaw(new URL(`http://127.0.0.1:${address.port}/servers`), 150, { maxBytes: 1000 })).rejects.toThrow('timed out');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      fetch.mockRestore();
      clearInterval(timer);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('bounds the HTTP/1 fallback stream and forbids redirects', async () => {
    const connect = jest.spyOn(http2, 'connect').mockImplementationOnce(() => { throw new Error('h2 unavailable'); });
    let cancelled = false;
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(128)); },
      cancel() { cancelled = true; },
    })));
    try {
      await expect(registryGetRaw(new URL('https://registry.example.test/servers'), 1000, { maxBytes: 100 })).rejects.toThrow('byte limit');
      expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
      expect(cancelled).toBe(true);
    } finally { connect.mockRestore(); fetch.mockRestore(); }
  });

  it('keeps a useful timeout reason when an HTTP/1 fallback keeps sending data', async () => {
    const server = http.createServer();
    let timer: ReturnType<typeof setInterval> | undefined;
    server.on('request', (_request, response) => {
      response.writeHead(200);
      timer = setInterval(() => response.write('x'), 10);
      response.on('close', () => clearInterval(timer));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const connect = jest.spyOn(http2, 'connect').mockImplementationOnce(() => { throw new Error('h2 unavailable'); });
    const fetch = jest.spyOn(global, 'fetch');
    try {
      await expect(registryGetRaw(new URL(`http://127.0.0.1:${address.port}/servers`), 150, { maxBytes: 1000 })).rejects.toThrow('timed out');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      connect.mockRestore();
      fetch.mockRestore();
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('cancels an actually opened HTTP/2 request without fallback or a lingering connection', async () => {
    const server = http2.createServer();
    const controller = new AbortController();
    server.on('stream', stream => {
      stream.respond({ ':status': 200 });
      stream.write('started');
      controller.abort(new DOMException('Caller cancelled', 'AbortError'));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const fetch = jest.spyOn(global, 'fetch');
    try {
      await expect(registryGetRaw(new URL(`http://127.0.0.1:${address.port}/servers`), 1000, { maxBytes: 1000, signal: controller.signal })).rejects.toThrow('Caller cancelled');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
