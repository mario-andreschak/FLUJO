import {
  ServerGroupingItem,
  ServerSortOption,
  deriveServerSortGroup,
  sortServers,
  compareServers,
} from '@/utils/shared/serverGrouping';

// Minimal server factory — only the fields the sort/grouping logic reads.
const server = (partial: Partial<ServerGroupingItem>): ServerGroupingItem => ({
  name: partial.name ?? 'server',
  status: partial.status,
  transport: partial.transport,
});

describe('deriveServerSortGroup', () => {
  it('folds name sorts by first letter', () => {
    const s = server({ name: 'alpha' });
    expect(deriveServerSortGroup(s, 'name-asc')).toEqual({ key: 'letter:A', label: 'A' });
    expect(deriveServerSortGroup(s, 'name-desc')).toEqual({ key: 'letter:A', label: 'A' });
  });

  it('folds status sorts by connection status', () => {
    expect(deriveServerSortGroup(server({ status: 'connected' }), 'status-connected')).toEqual({
      key: 'status:connected',
      label: 'Connected',
    });
    expect(deriveServerSortGroup(server({ status: 'error' }), 'status-connected')).toEqual({
      key: 'status:error',
      label: 'Error',
    });
    expect(deriveServerSortGroup(server({ status: 'requires_authentication' }), 'status-disconnected')).toEqual({
      key: 'status:auth',
      label: 'Requires authentication',
    });
    expect(deriveServerSortGroup(server({ status: 'disconnected' }), 'status-disconnected')).toEqual({
      key: 'status:disconnected',
      label: 'Disconnected',
    });
  });

  it('folds the transport sort by transport type with friendly labels', () => {
    expect(deriveServerSortGroup(server({ transport: 'stdio' }), 'transport')).toEqual({
      key: 'transport:stdio',
      label: 'Stdio',
    });
    expect(deriveServerSortGroup(server({ transport: 'streamable' }), 'transport')).toEqual({
      key: 'transport:streamable',
      label: 'Streamable HTTP',
    });
    // Unknown transport falls back to the raw key.
    expect(deriveServerSortGroup(server({}), 'transport')).toEqual({
      key: 'transport:unknown',
      label: 'unknown',
    });
  });
});

describe('sortServers', () => {
  it('sorts by name A–Z and Z–A', () => {
    const servers = [server({ name: 'charlie' }), server({ name: 'alpha' }), server({ name: 'bravo' })];
    expect(sortServers(servers, 'name-asc').map((s) => s.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(sortServers(servers, 'name-desc').map((s) => s.name)).toEqual(['charlie', 'bravo', 'alpha']);
  });

  it('sorts connected-first / disconnected-first with a stable name tie-break', () => {
    const servers = [
      server({ name: 'b', status: 'disconnected' }),
      server({ name: 'a', status: 'connected' }),
      server({ name: 'c', status: 'connected' }),
    ];
    expect(sortServers(servers, 'status-connected').map((s) => s.name)).toEqual(['a', 'c', 'b']);
    expect(sortServers(servers, 'status-disconnected').map((s) => s.name)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by transport in the preferred order, then by name', () => {
    const servers = [
      server({ name: 'z', transport: 'sse' }),
      server({ name: 'a', transport: 'stdio' }),
      server({ name: 'b', transport: 'stdio' }),
      server({ name: 'c', transport: 'streamable' }),
    ];
    expect(sortServers(servers, 'transport').map((s) => s.name)).toEqual(['a', 'b', 'z', 'c']);
  });

  it('does not mutate the input array', () => {
    const servers = [server({ name: 'b' }), server({ name: 'a' })];
    const before = servers.map((s) => s.name);
    sortServers(servers, 'name-asc');
    expect(servers.map((s) => s.name)).toEqual(before);
  });
});

describe('compareServers', () => {
  it('returns 0 for an unknown sort key', () => {
    const cmp = compareServers('bogus' as ServerSortOption);
    expect(cmp(server({ name: 'a' }), server({ name: 'b' }))).toBe(0);
  });
});
