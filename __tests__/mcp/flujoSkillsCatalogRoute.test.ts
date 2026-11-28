/**
 * The standalone Skill catalog (/api/mcp/flujo/skills) is what the bundled
 * FLUJO app answers `skills/list` with. Building it must never ask that app
 * again: the app would call the route, which would ask the app, forever, and
 * a chat with the built-in FLUJO agent opened thousands of connections until
 * the computer ran out of network ports.
 */
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';

const listServerSkills = jest.fn();
const loadServerConfigs = jest.fn();

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/backend/services/security/bundledFlujoWorkload', () => ({
  assertBundledFlujoWorkloadAction: async () => undefined,
  BundledFlujoWorkloadError: class BundledFlujoWorkloadError extends Error {},
  bundledFlujoWorkloadJsonResponse: (value: unknown, status = 200) => Response.json(value, { status }),
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...args: unknown[]) => loadServerConfigs(...args),
    listServerSkills: (...args: unknown[]) => listServerSkills(...args),
  },
}));

import { GET } from '@/app/api/mcp/flujo/skills/route';
import { servesStandaloneSkillCatalog } from '@/backend/services/mcp/standaloneSkills';

const descriptor = (directory: string) => SHIPPED_MCP_SERVERS.find((candidate) => candidate.packageDirectory === directory)!;
const skill = (name: string) => ({
  uri: `skill://${name}/SKILL.md`,
  frontmatter: { name, description: `${name} skill` },
  resources: [{ uri: `skill://${name}/SKILL.md`, digest: `sha256:${'0'.repeat(64)}`, size: 10 }],
});

describe('standalone Skill catalog', () => {
  beforeEach(() => {
    listServerSkills.mockReset();
    loadServerConfigs.mockReset();
  });

  it('never asks the bundled FLUJO app, which serves this very catalog', async () => {
    const flujo = createShippedServerConfig(descriptor('flujo'), {});
    const files = createShippedServerConfig(descriptor('filesystem'), {});
    loadServerConfigs.mockResolvedValue([flujo, files]);
    listServerSkills.mockImplementation(async (name: string) => (name === flujo.name
      ? { availability: 'supported', skills: [skill('loop')] }
      : { availability: 'supported', skills: [skill('notes')] }));

    const response = await (GET as unknown as (request?: Request) => Promise<Response>)();

    expect(response.status).toBe(200);
    expect(listServerSkills.mock.calls.map(([name]) => name)).toEqual([files.name]);
    const body = await response.json();
    expect(body.skills.map((entry: { frontmatter: { name: string } }) => entry.frontmatter.name)).toEqual(['notes']);
  });

  it('knows the bundled FLUJO app by what it is, not by its name', () => {
    const renamed = { ...createShippedServerConfig(descriptor('flujo'), {}), name: 'my-flujo' };
    expect(servesStandaloneSkillCatalog(renamed)).toBe(true);
    expect(servesStandaloneSkillCatalog({ ...createShippedServerConfig(descriptor('bash'), {}), name: 'flujo' })).toBe(false);
    expect(servesStandaloneSkillCatalog({ name: 'flujo', transport: 'streamable', serverUrl: 'http://127.0.0.1:1/mcp' } as never)).toBe(false);
  });
});
