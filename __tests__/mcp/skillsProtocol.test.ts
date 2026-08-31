import { createHash } from 'node:crypto';
import {
  MCP_SKILLS_MAX_RESOURCES,
  McpSkillsValidationError,
  parseMcpSkillUri,
  validateMcpListSkillsResult,
  validateMcpSkillEntry,
} from '@/shared/types/mcp';
import {
  decodeStandaloneSkillResource,
  rewriteMcpSkillEntryForStandalone,
} from '@/backend/services/mcp/standaloneSkills';

const manifest = '---\nname: pdf-skill\ndescription: Process PDF files\n---\nUse it carefully.\n';
const digest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;

function entry() {
  return {
    uri: 'skill://pdf-skill/SKILL.md',
    frontmatter: { name: 'pdf-skill', description: 'Process PDF files' },
    resources: [
      {
        uri: 'skill://pdf-skill/SKILL.md',
        digest,
        size: Buffer.byteLength(manifest),
      },
    ],
  };
}

describe('MCP Skills protocol validation', () => {
  it('accepts a complete, integrity-bound Skill entry', () => {
    expect(validateMcpSkillEntry(entry())).toEqual(entry());
    expect(parseMcpSkillUri('file:///skills/pdf-skill/SKILL.md').name).toBe('pdf-skill');
  });

  it('rejects malformed digests, duplicates, and resources outside the Skill root', () => {
    expect(() =>
      validateMcpSkillEntry({
        ...entry(),
        resources: [{ ...entry().resources[0], digest: 'sha256:ABC' }],
      }),
    ).toThrow(McpSkillsValidationError);

    expect(() =>
      validateMcpSkillEntry({
        ...entry(),
        resources: [entry().resources[0], entry().resources[0]],
      }),
    ).toThrow(/unique/);

    expect(() =>
      validateMcpSkillEntry({
        ...entry(),
        resources: [
          entry().resources[0],
          {
            uri: 'skill://other/file.txt',
            digest,
            size: 1,
          },
        ],
      }),
    ).toThrow(/contained/);
  });

  it('enforces the resource count ceiling and complete result discriminator', () => {
    const resources = Array.from({ length: MCP_SKILLS_MAX_RESOURCES + 1 }, (_, index) => ({
      uri: index === 0
        ? entry().uri
        : `skill://pdf-skill/file-${index}.txt`,
      digest,
      size: 0,
    }));
    expect(() => validateMcpSkillEntry({ ...entry(), resources })).toThrow(/1-512/);
    expect(() =>
      validateMcpListSkillsResult({ resultType: 'partial', skills: [] }),
    ).toThrow(/complete/);
  });

  it('keeps equal source URIs distinct on the standalone server surface', () => {
    const source = validateMcpSkillEntry(entry());
    const a = rewriteMcpSkillEntryForStandalone('server-a', source);
    const b = rewriteMcpSkillEntryForStandalone('server-b', source);
    expect(a.uri).not.toBe(b.uri);
    expect(decodeStandaloneSkillResource(a.uri)).toMatchObject({
      serverName: 'server-a',
      skillUri: source.uri,
      resourceUri: source.uri,
    });
  });
});
