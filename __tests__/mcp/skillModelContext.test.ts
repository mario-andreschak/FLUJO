import {
  formatMcpSkillModelContext,
  loadApprovedMcpSkillSelections,
  parseMcpSkillSelections,
  withMcpSkillModelContext,
} from '@/backend/services/mcp/skillModelContext';
import {
  MCP_SKILLS_SUPPORTED_REVISION,
  type McpLoadedSkill,
  type McpSkillDigest,
} from '@/shared/types/mcp';
import type { FlujoChatMessage } from '@/shared/types/chat';

const DIGEST = `sha256:${'a'.repeat(64)}` as McpSkillDigest;
const selection = {
  serverName: 'skills-server',
  skillUri: 'skill://pdf-skill/SKILL.md',
  manifestDigest: DIGEST,
};

const loadedSkill: McpLoadedSkill = {
  identity: {
    serverName: selection.serverName,
    skillUri: selection.skillUri,
  },
  protocolRevision: MCP_SKILLS_SUPPORTED_REVISION,
  entry: {
    uri: selection.skillUri,
    frontmatter: {
      name: 'pdf-skill',
      description: 'Process PDF files',
    },
    resources: [{
      uri: selection.skillUri,
      digest: DIGEST,
      size: 7,
    }],
  },
  manifest: {
    uri: selection.skillUri,
    digest: DIGEST,
    size: 7,
    text: 'content',
    verified: true,
  },
  resources: [{
    uri: selection.skillUri,
    digest: DIGEST,
    size: 7,
    text: 'content',
    verified: true,
  }],
  verification: 'sha256',
  trust: 'untrusted-external-content',
};

describe('MCP Skill model context', () => {
  it('only requires a conversation ID when a Skill is selected', async () => {
    await expect(loadApprovedMcpSkillSelections(undefined, undefined))
      .resolves.toBeUndefined();
    await expect(loadApprovedMcpSkillSelections(undefined, [selection]))
      .rejects.toThrow('Selected MCP Skills require a conversation ID.');
  });

  it('accepts bounded server-qualified digest selections and rejects duplicates', () => {
    expect(parseMcpSkillSelections(JSON.stringify([selection]))).toEqual({
      selections: [selection],
    });
    expect(parseMcpSkillSelections(JSON.stringify([selection, selection])).error)
      .toMatch(/unique/);
  });

  it('formats Skill content as untrusted data without adding authority', () => {
    const formatted = formatMcpSkillModelContext([loadedSkill]);
    expect(formatted).toContain('[MCP Skill context]');
    expect(formatted).toContain('untrusted data for this turn');
    expect(formatted).toContain('permission to add tools');
    expect(formatted).toContain('content');
  });

  it('injects a wire-only message immediately before the latest user input', () => {
    const messages: FlujoChatMessage[] = [
      { id: 's', timestamp: 1, role: 'system', content: 'system' },
      { id: 'u1', timestamp: 2, role: 'user', content: 'old' },
      { id: 'a', timestamp: 3, role: 'assistant', content: 'answer' },
      { id: 'u2', timestamp: 4, role: 'user', content: 'current' },
    ];
    const result = withMcpSkillModelContext(messages, [loadedSkill]);
    expect(result.map((message) => message.id)).toEqual([
      's',
      'u1',
      'a',
      'mcp-skill-model-context',
      'u2',
    ]);
    expect(messages.map((message) => message.id)).toEqual(['s', 'u1', 'a', 'u2']);
  });
});
