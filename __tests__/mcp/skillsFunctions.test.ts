import { createHash } from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_SKILLS_EXTENSION_ID,
  validateMcpSkillEntry,
} from '@/shared/types/mcp';
import {
  McpSkillsUnsupportedError,
  getMcpSkill,
  listMcpSkills,
  readMcpSkillDirectory,
  readVerifiedMcpSkillResource,
} from '@/backend/services/mcp/skills';

const manifest = '---\nname: demo-skill\ndescription: Demonstrate Skills\n---\nHello.\n';
const entry = validateMcpSkillEntry({
  uri: 'skill://demo-skill/SKILL.md',
  frontmatter: { name: 'demo-skill', description: 'Demonstrate Skills' },
  resources: [{
    uri: 'skill://demo-skill/SKILL.md',
    digest: `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
    size: Buffer.byteLength(manifest),
  }],
});

function client(overrides: Record<string, unknown> = {}) {
  return {
    getServerCapabilities: jest.fn(() => ({
      extensions: {
        [MCP_SKILLS_EXTENSION_ID]: { directoryRead: true },
      },
    })),
    request: jest.fn(async (request: { method: string }) => {
      if (request.method === 'skills/list') {
        return { resultType: 'complete', skills: [entry], nextCursor: 'next' };
      }
      if (request.method === 'skills/get') {
        return { resultType: 'complete', skill: entry };
      }
      return { resultType: 'complete', resources: [] };
    }),
    readResource: jest.fn(async () => ({
      contents: [{ uri: entry.uri, text: manifest, mimeType: 'text/markdown' }],
    })),
    ...overrides,
  } as any;
}

describe('MCP Skills downstream adapter', () => {
  it('requires local opt-in and the negotiated server extension', async () => {
    await expect(listMcpSkills(client(), false)).rejects.toMatchObject({
      reason: 'disabled',
    });
    const unsupported = client({
      getServerCapabilities: jest.fn(() => ({ extensions: {} })),
    });
    await expect(listMcpSkills(unsupported, true)).rejects.toMatchObject({
      reason: 'extension-not-negotiated',
    });
  });

  it('preserves pagination and exact URI identity', async () => {
    const fake = client();
    await expect(listMcpSkills(fake, true, 'cursor')).resolves.toMatchObject({
      nextCursor: 'next',
      skills: [entry],
    });
    await expect(getMcpSkill(fake, true, entry.uri)).resolves.toMatchObject({
      skill: entry,
    });
    expect(fake.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'skills/get', params: { uri: entry.uri } }),
      expect.anything(),
    );
  });

  it('maps method-not-found to a stable unsupported reason', async () => {
    const fake = client({
      request: jest.fn(async () => {
        throw new McpError(ErrorCode.MethodNotFound, 'missing');
      }),
    });
    await expect(listMcpSkills(fake, true)).rejects.toBeInstanceOf(
      McpSkillsUnsupportedError,
    );
  });

  it('never reads a directory without the negotiated bit', async () => {
    const fake = client({
      getServerCapabilities: jest.fn(() => ({
        extensions: { [MCP_SKILLS_EXTENSION_ID]: {} },
      })),
    });
    await expect(readMcpSkillDirectory(fake, true, entry.uri)).rejects.toMatchObject({
      reason: 'directory-read-not-negotiated',
    });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it('verifies declared size and SHA-256 before returning content', async () => {
    const fake = client();
    await expect(
      readVerifiedMcpSkillResource(fake, true, entry, entry.uri),
    ).resolves.toMatchObject({
      uri: entry.uri,
      text: manifest,
      verified: true,
    });

    fake.readResource.mockResolvedValueOnce({
      contents: [{ uri: entry.uri, text: `${manifest}tampered` }],
    });
    await expect(
      readVerifiedMcpSkillResource(fake, true, entry, entry.uri),
    ).rejects.toThrow(/size verification failed/);
  });
});
