/**
 * Event automations heal a dead connection on their own (#1401): a request that
 * failed because the client stopped answering rebuilds the connection and is tried
 * once more; a server that still answers keeps its own error.
 */
import { healDeadConnection, withLiveConnection, type LiveConnectionBackend } from '@/backend/services/mcp/liveConnection';

function client(alive: boolean) {
  return { ping: jest.fn(async () => { if (!alive) throw new Error('Session not found'); return {}; }) };
}

function backend(initial: ReturnType<typeof client> | undefined, replacement = client(true)) {
  let current = initial;
  const service = {
    getClient: jest.fn((_serverName: string) => current),
    forceReconnect: jest.fn(async (_serverName: string) => {
      current = replacement;
      return { success: true };
    }),
    replace(next: ReturnType<typeof client> | undefined) { current = next; },
  };
  return service satisfies LiveConnectionBackend;
}

describe('withLiveConnection', () => {
  it('returns the answer and leaves a working connection alone', async () => {
    const service = backend(client(true));
    await expect(withLiveConnection(service, 'chat', async () => 'ok')).resolves.toBe('ok');
    expect(service.getClient('chat')!.ping).not.toHaveBeenCalled();
    expect(service.forceReconnect).not.toHaveBeenCalled();
  });

  it('keeps the error of a server that still answers', async () => {
    const service = backend(client(true));
    const request = jest.fn(async () => { throw new Error('NotFound'); });
    await expect(withLiveConnection(service, 'chat', request)).rejects.toThrow('NotFound');
    expect(request).toHaveBeenCalledTimes(1);
    expect(service.forceReconnect).not.toHaveBeenCalled();
  });

  it('rebuilds a connection that stopped answering and tries once more', async () => {
    const service = backend(client(false));
    const request = jest.fn()
      .mockRejectedValueOnce(new Error('Error POSTing to endpoint (HTTP 404): Session not found'))
      .mockResolvedValueOnce('opened');
    await expect(withLiveConnection(service, 'chat', request)).resolves.toBe('opened');
    expect(service.forceReconnect).toHaveBeenCalledWith('chat');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('tries again on a client someone else already put in place', async () => {
    const service = backend(client(false));
    const request = jest.fn()
      .mockImplementationOnce(async () => {
        service.replace(client(true));
        throw new Error('Connection closed');
      })
      .mockResolvedValueOnce('opened');
    await expect(withLiveConnection(service, 'chat', request)).resolves.toBe('opened');
    expect(service.forceReconnect).not.toHaveBeenCalled();
  });

  it('reports the request error when reconnecting fails, so the caller backs off', async () => {
    const service = backend(client(false));
    service.forceReconnect.mockResolvedValueOnce({ success: false });
    const request = jest.fn(async () => { throw new Error('fetch failed'); });
    await expect(withLiveConnection(service, 'chat', request)).rejects.toThrow('fetch failed');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('leaves the error alone when no client was connected', async () => {
    const service = backend(undefined);
    await expect(withLiveConnection(service, 'chat', async () => { throw new Error('ECONNREFUSED'); }))
      .rejects.toThrow('ECONNREFUSED');
    expect(service.forceReconnect).not.toHaveBeenCalled();
  });
});

describe('healDeadConnection', () => {
  it('rebuilds only a client that does not answer', async () => {
    const alive = backend(client(true));
    await healDeadConnection(alive, 'chat');
    expect(alive.forceReconnect).not.toHaveBeenCalled();

    const dead = backend(client(false));
    await healDeadConnection(dead, 'chat');
    expect(dead.forceReconnect).toHaveBeenCalledWith('chat');

    const none = backend(undefined);
    await healDeadConnection(none, 'chat');
    expect(none.forceReconnect).not.toHaveBeenCalled();
  });
});
