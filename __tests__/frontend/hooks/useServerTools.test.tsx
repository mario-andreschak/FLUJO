import { act, renderHook, waitFor } from '@testing-library/react';
import { useServerTools } from '@/frontend/hooks/useServerTools';
import { mcpService } from '@/frontend/services/mcp';

jest.mock('@/frontend/services/mcp', () => ({
  mcpService: {
    listServerTools: jest.fn(),
    clearToolsCache: jest.fn(),
    callTool: jest.fn(),
  },
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockListServerTools = mcpService.listServerTools as jest.MockedFunction<
  typeof mcpService.listServerTools
>;
const mockClearToolsCache = mcpService.clearToolsCache as jest.MockedFunction<
  typeof mcpService.clearToolsCache
>;

type ToolListResult = Awaited<ReturnType<typeof mcpService.listServerTools>>;

const tool = (name: string, description?: string) => ({
  name,
  description,
  inputSchema: { type: 'object' as const },
});

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('useServerTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('owns the initial bound-server request and normalizes successful tools', async () => {
    mockListServerTools.mockResolvedValue({
      tools: [tool('read_record')],
    } as ToolListResult);

    const { result } = renderHook(() => useServerTools('records'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockListServerTools).toHaveBeenCalledTimes(1);
    expect(mockListServerTools).toHaveBeenCalledWith('records');
    expect(result.current.tools).toEqual([
      expect.objectContaining({ name: 'read_record', description: '' }),
    ]);
    expect(result.current.toolsServerName).toBe('records');
    expect(result.current.error).toBeNull();
  });

  it('loads the first server selected from an initially unbound state', async () => {
    mockListServerTools.mockResolvedValue({
      tools: [tool('search')],
    } as ToolListResult);

    const initialProps: { server: string | null } = { server: null };
    const { result, rerender } = renderHook(
      ({ server }: { server: string | null }) => useServerTools(server),
      { initialProps },
    );

    expect(mockListServerTools).not.toHaveBeenCalled();
    rerender({ server: 'records' });

    await waitFor(() => expect(result.current.toolsServerName).toBe('records'));
    expect(mockListServerTools).toHaveBeenCalledTimes(1);
    expect(result.current.tools.map(({ name }) => name)).toEqual(['search']);
  });

  it('surfaces an API-body error from the initial request', async () => {
    mockListServerTools.mockResolvedValue({
      tools: [],
      error: 'Tool discovery failed',
    });

    const { result } = renderHook(() => useServerTools('records'));

    await waitFor(() => expect(result.current.error).toBe('Tool discovery failed'));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.tools).toEqual([]);
    expect(result.current.toolsServerName).toBeNull();
  });

  it('surfaces a thrown initial-request error', async () => {
    mockListServerTools.mockRejectedValue(new Error('connection closed'));

    const { result } = renderHook(() => useServerTools('records'));

    await waitFor(() => {
      expect(result.current.error).toBe('Failed to load tools: connection closed');
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.toolsServerName).toBeNull();
  });

  it('marks a successful empty result as belonging to the selected server', async () => {
    mockListServerTools.mockResolvedValue({ tools: [] });

    const { result } = renderHook(() => useServerTools('records'));

    await waitFor(() => expect(result.current.toolsServerName).toBe('records'));

    expect(result.current.tools).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('keeps the new server loading when the previous server finishes late', async () => {
    const serverA = deferred<ToolListResult>();
    const serverB = deferred<ToolListResult>();
    mockListServerTools
      .mockImplementationOnce(() => serverA.promise)
      .mockImplementationOnce(() => serverB.promise);

    const { result, rerender } = renderHook(
      ({ server }: { server: string | null }) => useServerTools(server),
      { initialProps: { server: 'A' } },
    );
    await waitFor(() => expect(mockListServerTools).toHaveBeenCalledTimes(1));

    rerender({ server: 'B' });
    await waitFor(() => expect(mockListServerTools).toHaveBeenCalledTimes(2));

    await act(async () => {
      serverA.resolve({ tools: [tool('stale_a')] } as ToolListResult);
      await serverA.promise;
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.tools).toEqual([]);
    expect(result.current.toolsServerName).toBeNull();

    await act(async () => {
      serverB.resolve({ tools: [tool('current_b')] } as ToolListResult);
      await serverB.promise;
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.tools.map(({ name }) => name)).toEqual(['current_b']);
    expect(result.current.toolsServerName).toBe('B');
  });

  it('loads a newly selected server inside the previous server throttle window', async () => {
    mockListServerTools
      .mockResolvedValueOnce({ tools: [tool('server_a')] } as ToolListResult)
      .mockResolvedValueOnce({ tools: [tool('server_b')] } as ToolListResult);

    const { result, rerender } = renderHook(
      ({ server }: { server: string | null }) => useServerTools(server),
      { initialProps: { server: 'A' } },
    );
    await waitFor(() => expect(result.current.toolsServerName).toBe('A'));

    rerender({ server: 'B' });

    await waitFor(() => expect(result.current.toolsServerName).toBe('B'));
    expect(mockListServerTools).toHaveBeenCalledTimes(2);
    expect(result.current.tools.map(({ name }) => name)).toEqual(['server_b']);
  });

  it('ignores stale completions across an A -> B -> A selection sequence', async () => {
    const firstA = deferred<ToolListResult>();
    const serverB = deferred<ToolListResult>();
    const latestA = deferred<ToolListResult>();
    mockListServerTools
      .mockImplementationOnce(() => firstA.promise)
      .mockImplementationOnce(() => serverB.promise)
      .mockImplementationOnce(() => latestA.promise);

    const { result, rerender } = renderHook(
      ({ server }: { server: string | null }) => useServerTools(server),
      { initialProps: { server: 'A' } },
    );
    await waitFor(() => expect(mockListServerTools).toHaveBeenCalledTimes(1));

    rerender({ server: 'B' });
    await waitFor(() => expect(mockListServerTools).toHaveBeenCalledTimes(2));

    rerender({ server: 'A' });
    await waitFor(() => expect(mockListServerTools).toHaveBeenCalledTimes(3));

    await act(async () => {
      latestA.resolve({ tools: [tool('latest_a', 'Latest A')] } as ToolListResult);
      await latestA.promise;
    });
    expect(result.current.tools.map(({ name }) => name)).toEqual(['latest_a']);
    expect(result.current.toolsServerName).toBe('A');

    await act(async () => {
      firstA.resolve({ tools: [tool('stale_a', 'Stale A')] } as ToolListResult);
      serverB.resolve({ tools: [], error: 'Stale B failure' });
      await Promise.all([firstA.promise, serverB.promise]);
    });

    expect(result.current.tools.map(({ name }) => name)).toEqual(['latest_a']);
    expect(result.current.toolsServerName).toBe('A');
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('lets only the latest overlapping request for one server update state', async () => {
    const initial = deferred<ToolListResult>();
    const forced = deferred<ToolListResult>();
    mockListServerTools
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => forced.promise);

    const { result } = renderHook(() => useServerTools('records'));
    await waitFor(() => expect(mockListServerTools).toHaveBeenCalledTimes(1));

    act(() => {
      void result.current.loadTools(true);
    });
    await waitFor(() => expect(mockListServerTools).toHaveBeenCalledTimes(2));

    await act(async () => {
      forced.resolve({ tools: [tool('fresh')] } as ToolListResult);
      await forced.promise;
    });
    await act(async () => {
      initial.resolve({ tools: [tool('stale')] } as ToolListResult);
      await initial.promise;
    });

    expect(mockClearToolsCache).toHaveBeenCalledWith('records');
    expect(result.current.tools.map(({ name }) => name)).toEqual(['fresh']);
    expect(result.current.toolsServerName).toBe('records');
  });

  it('clears the selected server cache before a scheduled retry', async () => {
    jest.useFakeTimers();
    mockListServerTools
      .mockResolvedValueOnce({ tools: [], error: 'Temporarily unavailable' })
      .mockResolvedValueOnce({ tools: [tool('recovered')] } as ToolListResult);

    const { result } = renderHook(() => useServerTools('records'));
    await waitFor(() => expect(result.current.error).toBe('Temporarily unavailable'));

    act(() => {
      result.current.retryLoadTools();
    });
    expect(result.current.isRetrying).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockClearToolsCache).toHaveBeenCalledTimes(1);
    expect(mockClearToolsCache).toHaveBeenCalledWith('records');
    expect(mockClearToolsCache.mock.invocationCallOrder[0]).toBeLessThan(
      mockListServerTools.mock.invocationCallOrder[1],
    );
    expect(result.current.tools.map(({ name }) => name)).toEqual(['recovered']);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('cancels a scheduled retry when the hook unmounts', async () => {
    jest.useFakeTimers();
    mockListServerTools.mockResolvedValue({ tools: [], error: 'Unavailable' });

    const { result, unmount } = renderHook(() => useServerTools('records'));
    await waitFor(() => expect(result.current.error).toBe('Unavailable'));

    act(() => {
      result.current.retryLoadTools();
    });
    expect(jest.getTimerCount()).toBe(1);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
    expect(mockListServerTools).toHaveBeenCalledTimes(1);
  });

  it('invalidates pending work when the selection is cleared', async () => {
    const pending = deferred<ToolListResult>();
    mockListServerTools.mockImplementation(() => pending.promise);

    const initialProps: { server: string | null } = { server: 'records' };
    const { result, rerender } = renderHook(
      ({ server }: { server: string | null }) => useServerTools(server),
      { initialProps },
    );
    await waitFor(() => expect(mockListServerTools).toHaveBeenCalledTimes(1));

    rerender({ server: null });
    expect(result.current.tools).toEqual([]);
    expect(result.current.toolsServerName).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      pending.resolve({ tools: [tool('stale')] } as ToolListResult);
      await pending.promise;
    });

    expect(result.current.tools).toEqual([]);
    expect(result.current.toolsServerName).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
