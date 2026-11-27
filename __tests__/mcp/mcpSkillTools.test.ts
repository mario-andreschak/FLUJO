import {
  buildMcpSkillTools,
  executeMcpSkillTool,
  LOAD_MCP_SKILL_TOOL_NAME,
} from '@/backend/execution/flow/handlers/mcpSkillTools';
import { clearConversationMcpSkillApprovals } from '@/backend/services/mcp/skillApprovalRegistry';
import { registerPendingQuestion } from '@/backend/services/questionRegistry';
import { mcpService } from '@/backend/services/mcp';
import type { MCPNodeReference } from '@/backend/execution/flow/types';

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    listServerSkills: jest.fn(),
    getServerSkill: jest.fn(),
    loadVerifiedSkill: jest.fn(),
  },
}));
jest.mock('@/backend/services/questionRegistry', () => ({ registerPendingQuestion: jest.fn() }));

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SKILL_URI = 'skill://refunds/SKILL.md';
const entry = {
  uri: SKILL_URI,
  frontmatter: { name: 'refunds', description: 'Process customer refunds per policy' },
  resources: [{ uri: SKILL_URI, digest: DIGEST, size: 10 }],
};
const loaded = {
  identity: { serverName: 'billing', skillUri: SKILL_URI },
  protocolRevision: '2026-07-28',
  entry,
  manifest: { uri: SKILL_URI, digest: DIGEST, mimeType: 'text/markdown', text: '# Refunds\nStep 1' },
  resources: [{ uri: SKILL_URI, digest: DIGEST, mimeType: 'text/markdown', text: '# Refunds\nStep 1' }],
  verification: 'sha256',
  trust: 'untrusted-external-content',
};
const nodes = [
  { id: 'm1', properties: { boundServer: 'billing' } },
  { id: 'm2', properties: { boundServer: 'plain' } },
] as unknown as MCPNodeReference[];

const service = mcpService as unknown as Record<'listServerSkills' | 'getServerSkill' | 'loadVerifiedSkill', jest.Mock>;
const ask = registerPendingQuestion as unknown as jest.Mock;

beforeEach(() => {
  service.listServerSkills.mockImplementation(async (server: string) => server === 'billing'
    ? { resultType: 'complete', serverName: server, availability: 'available', skills: [entry] }
    : { resultType: 'complete', serverName: server, availability: 'unsupported', skills: [] });
  service.getServerSkill.mockResolvedValue({ success: true, data: { resultType: 'complete', skill: entry } });
  service.loadVerifiedSkill.mockResolvedValue({ success: true, data: loaded });
});
afterEach(() => {
  clearConversationMcpSkillApprovals('conv-skill');
  jest.clearAllMocks();
});

describe('Skills over MCP for agents (#1448)', () => {
  it('lists skills from every bound server that offers them, as metadata only', async () => {
    const [tool] = await buildMcpSkillTools(nodes);
    expect(tool.name).toBe(LOAD_MCP_SKILL_TOOL_NAME);
    expect(tool.description).toContain('billing:refunds (uri skill://refunds/SKILL.md): Process customer refunds per policy');
    expect(tool.inputSchema).toMatchObject({ properties: { server: { enum: ['billing'] } }, required: ['server', 'uri'] });
    expect(service.listServerSkills).toHaveBeenCalledWith('billing', undefined);
    expect(service.loadVerifiedSkill).not.toHaveBeenCalled();
  });

  it('offers no tool when no bound server has a skill', async () => {
    service.listServerSkills.mockResolvedValue({ resultType: 'complete', serverName: 'x', availability: 'disabled', skills: [] });
    await expect(buildMcpSkillTools(nodes)).resolves.toEqual([]);
  });

  it('asks the person once per conversation, then returns verified text as untrusted data', async () => {
    ask.mockResolvedValue({ action: 'answer', answers: [['Allow']] });
    const ctx = { conversationId: 'conv-skill', mcpNodes: nodes, emit: jest.fn() };

    const first = await executeMcpSkillTool({ server: 'billing', uri: SKILL_URI }, ctx);
    expect(first.success).toBe(true);
    expect(String(first.data)).toContain('[MCP Skill context]');
    expect(String(first.data)).toContain('untrusted data');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'run:awaiting_question' }));

    await executeMcpSkillTool({ server: 'billing', uri: SKILL_URI }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(service.loadVerifiedSkill).toHaveBeenCalledTimes(2);
  });

  it('loads nothing when the person says no, or when nobody watches the run', async () => {
    ask.mockResolvedValue({ action: 'answer', answers: [['Do not allow']] });
    const denied = await executeMcpSkillTool({ server: 'billing', uri: SKILL_URI }, { conversationId: 'conv-skill', mcpNodes: nodes });
    expect(denied).toEqual({ success: true, data: expect.stringContaining('did not allow') });

    ask.mockClear();
    const unattended = await executeMcpSkillTool({ server: 'billing', uri: SKILL_URI }, { conversationId: 'conv-skill', mcpNodes: nodes, unattended: true });
    expect(unattended.success).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(service.loadVerifiedSkill).not.toHaveBeenCalled();
  });

  it('refuses servers outside this step, bad uris and skills that cannot be checked', async () => {
    const ctx = { conversationId: 'conv-skill', mcpNodes: nodes };
    expect(await executeMcpSkillTool({ server: 'elsewhere', uri: SKILL_URI }, ctx)).toMatchObject({ success: false });
    expect(await executeMcpSkillTool({ server: 'billing', uri: 'https://x/SKILL.md' }, ctx)).toMatchObject({ success: false });
    service.getServerSkill.mockResolvedValueOnce({ success: true, data: { skill: { ...entry, resources: 'dynamic' } } });
    expect(await executeMcpSkillTool({ server: 'billing', uri: SKILL_URI }, ctx)).toMatchObject({ success: false });
    expect(ask).not.toHaveBeenCalled();
  });
});
