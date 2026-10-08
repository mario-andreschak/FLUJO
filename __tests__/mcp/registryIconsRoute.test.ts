const assertUnlockedMock = jest.fn();
const registryGetRawMock = jest.fn();
const rankRegistryResultsMock = jest.fn();

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/backend/utils/registryClient', () => ({
  REGISTRY_ORIGIN: 'https://registry.example.test',
  registryGetRaw: (...args: unknown[]) => registryGetRawMock(...args),
}));

jest.mock('@/backend/services/mcp/registryInstall', () => ({
  rankRegistryResults: (...args: unknown[]) => rankRegistryResultsMock(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/mcp-registry/route';

describe('GET /api/mcp-registry icon metadata mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(null);
    registryGetRawMock.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        servers: [
          {
            server: {
              name: 'io.example/logo-route-test',
              icons: [{ src: 'https://example.com/logo.svg' }],
            },
          },
        ],
      }),
    });
  });

  it('returns raw registry metadata without quality ranking when iconsOnly is true', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/mcp-registry?search=io.example%2Flogo-route-test&limit=10&iconsOnly=true',
    ));

    expect(response.status).toBe(200);
    expect(rankRegistryResultsMock).not.toHaveBeenCalled();
    expect(registryGetRawMock).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      servers: [
        {
          server: {
            name: 'io.example/logo-route-test',
            icons: [{ src: 'https://example.com/logo.svg' }],
          },
        },
      ],
    });
  });

  it('keeps quality ranking enabled for the ordinary marketplace request', async () => {
    rankRegistryResultsMock.mockResolvedValueOnce([
      {
        server: { name: 'io.example/logo-route-test' },
        quality: { score: 0.9 },
      },
    ]);

    const response = await GET(new NextRequest(
      'http://localhost/api/mcp-registry?search=io.example%2Flogo-route-ranked-test&limit=10',
    ));

    expect(response.status).toBe(200);
    expect(rankRegistryResultsMock).toHaveBeenCalledTimes(1);
    expect(rankRegistryResultsMock).toHaveBeenCalledWith(
      'io.example/logo-route-ranked-test',
      expect.any(Array),
    );
    await expect(response.json()).resolves.toMatchObject({
      servers: [
        {
          server: { name: 'io.example/logo-route-test' },
          quality: { score: 0.9 },
        },
      ],
    });
  });
});
