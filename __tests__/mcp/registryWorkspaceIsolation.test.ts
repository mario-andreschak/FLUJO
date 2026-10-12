const assertUnlockedMock = jest.fn(async () => null);
const registryGetRawMock = jest.fn();
const discoverRegistryServersMock = jest.fn();

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: () => assertUnlockedMock() }));
jest.mock('@/backend/utils/registryClient', () => ({
  REGISTRY_ORIGIN: 'https://registry.example.test',
  registryGetRaw: (...args: unknown[]) => registryGetRawMock(...args),
}));
jest.mock('@/backend/services/mcp/registryDiscovery', () => ({
  discoverRegistryServers: (...args: unknown[]) => discoverRegistryServersMock(...args),
}));
// Installation is unused. Keep the real route admission, workspace context,
// settings storage, ranking orchestrator and local status provider below.
jest.mock('@/backend/services/mcp', () => ({ mcpService: {} }));

import fs from 'node:fs/promises';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/mcp-registry/route';
import { defaultQualitySettings, saveQualitySettings } from '@/backend/services/mcp/quality/settings';
import { getCurrentWorkspace, getWorkspaceDir, runWithWorkspace } from '@/utils/workspace';
import type { RegistryServerResult } from '@/utils/mcp/registry';

const servers: RegistryServerResult[] = [
  { server: { name: 'io.example/a-deprecated' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } } },
  { server: { name: 'io.example/z-active' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } },
];
const discovery = { servers, discovery: { bounded: true, terms: ['isolation'], partial: false, truncated: false } };

function request(workspace: string, search = '', cursor = '', iconsOnly = false, useHeader = false) {
  const params = new URLSearchParams({ search, cursor, limit: '1', iconsOnly: String(iconsOnly) });
  if (!useHeader) params.set('workspace', workspace);
  return new NextRequest(`http://localhost/api/mcp-registry?${params}`, {
    headers: useHeader ? { 'x-flujo-workspace': workspace } : undefined,
  });
}

describe('Marketplace workspace ranking isolation', () => {
  let enabledWorkspace: string;
  let disabledWorkspace: string;
  let run = 0;

  beforeEach(async () => {
    jest.clearAllMocks();
    assertUnlockedMock.mockReset().mockResolvedValue(null);
    run += 1;
    enabledWorkspace = `registry-status-enabled-${run}`;
    disabledWorkspace = `registry-status-disabled-${run}`;
    for (const workspace of [enabledWorkspace, disabledWorkspace]) {
      await fs.mkdir(getWorkspaceDir(workspace), { recursive: true });
      const settings = defaultQualitySettings();
      settings.providers = settings.providers.map(provider => ({
        ...provider,
        enabled: workspace === enabledWorkspace && provider.id === 'registry-status',
      }));
      await runWithWorkspace(workspace, () => saveQualitySettings(settings));
    }
    discoverRegistryServersMock.mockResolvedValue(discovery);
    registryGetRawMock.mockResolvedValue({ status: 200, body: JSON.stringify({ servers }) });
  });

  it('deduplicates pending discovery only within the selected workspace and preserves its ranking', async () => {
    let release!: () => void;
    let allAdmitted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admitted = new Promise<void>(resolve => { allAdmitted = resolve; });
    let admissions = 0;
    assertUnlockedMock.mockImplementation(async () => {
      if (++admissions === 3) allAdmitted();
      return null;
    });
    const seen: string[] = [];
    discoverRegistryServersMock.mockImplementation(async () => {
      seen.push(getCurrentWorkspace());
      await gate;
      return discovery;
    });
    const pending = [
      GET(request(enabledWorkspace, 'isolation parallel')),
      GET(request(enabledWorkspace, ' Isolation  Parallel ', '', false, true)),
      GET(request(disabledWorkspace, 'isolation parallel')),
    ];
    try {
      await admitted;
      // All three real route wrappers have selected their workspace. Let their
      // handlers reach discovery before releasing the blocked acquisition.
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally { release(); }
    const [enabled, sameWorkspace, disabled] = await Promise.all(pending.map(async response => (await response).json()));

    expect(seen.sort()).toEqual([enabledWorkspace, disabledWorkspace].sort());
    expect(enabled.servers[0]).toMatchObject({ server: { name: 'io.example/z-active' }, quality: { score: 1, status: 'active' } });
    expect(sameWorkspace.metadata.nextCursor).toBe(enabled.metadata.nextCursor);
    expect(disabled.servers[0].server.name).toBe('io.example/a-deprecated');
    expect(disabled.servers[0].quality).toBeUndefined();
    expect(disabled.metadata.nextCursor).not.toBe(enabled.metadata.nextCursor);

    const cached = await (await GET(request(disabledWorkspace, 'isolation parallel', '', false, true))).json();
    expect(cached).toEqual(disabled);
    expect(discoverRegistryServersMock).toHaveBeenCalledTimes(2);
    expect(getCurrentWorkspace()).toBe('default-workspace');
  });

  it('rejects a cursor from another workspace before acquisition, even when both have the same query', async () => {
    const enabled = await (await GET(request(enabledWorkspace, 'isolation cursors'))).json();
    expect((await GET(request(disabledWorkspace, 'isolation cursors', enabled.metadata.nextCursor))).status).toBe(410);
    expect(discoverRegistryServersMock).toHaveBeenCalledTimes(1);

    const disabled = await (await GET(request(disabledWorkspace, 'isolation cursors'))).json();
    expect((await GET(request(disabledWorkspace, 'isolation cursors', enabled.metadata.nextCursor))).status).toBe(410);
    expect((await GET(request(enabledWorkspace, 'isolation cursors', disabled.metadata.nextCursor))).status).toBe(410);
    const second = await (await GET(request(enabledWorkspace, 'isolation cursors', enabled.metadata.nextCursor))).json();
    expect(second.servers[0].server.name).toBe('io.example/a-deprecated');
    expect(second.metadata.nextCursor).toBeUndefined();
    expect(discoverRegistryServersMock).toHaveBeenCalledTimes(2);
  });

  it('isolates cached ordinary listings by provider settings while reusing public icon metadata', async () => {
    const enabled = await (await GET(request(enabledWorkspace))).json();
    const disabled = await (await GET(request(disabledWorkspace, '', '', false, true))).json();
    expect(enabled.servers[0]).toMatchObject({ server: { name: 'io.example/z-active' }, quality: { score: 1 } });
    expect(disabled.servers[0].server.name).toBe('io.example/a-deprecated');
    expect(disabled.servers[0].quality).toBeUndefined();
    expect(await (await GET(request(enabledWorkspace))).json()).toEqual(enabled);
    expect(await (await GET(request(disabledWorkspace))).json()).toEqual(disabled);
    expect(registryGetRawMock).toHaveBeenCalledTimes(2);

    const icons = await (await GET(request(enabledWorkspace, 'isolation icons', '', true))).json();
    expect(icons.servers).toEqual(servers);
    expect(await (await GET(request(disabledWorkspace, 'isolation icons', '', true))).json()).toEqual(icons);
    expect(registryGetRawMock).toHaveBeenCalledTimes(3);
    expect(discoverRegistryServersMock).not.toHaveBeenCalled();
  });
});
