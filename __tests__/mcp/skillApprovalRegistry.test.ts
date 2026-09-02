import {
  approveMcpSkill,
  clearConversationMcpSkillApprovals,
  getApprovedMcpSkill,
} from '@/backend/services/mcp/skillApprovalRegistry';
import type { McpSkillDigest } from '@/shared/types/mcp';
import { runWithWorkspace } from '@/utils/workspace';

const DIGEST_A = `sha256:${'a'.repeat(64)}` as McpSkillDigest;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as McpSkillDigest;
const base = {
  conversationId: 'conversation-skill-approval',
  serverName: 'skills-server',
  skillUri: 'skill://pdf-skill/SKILL.md',
  manifestDigest: DIGEST_A,
};

describe('MCP Skill approval registry', () => {
  afterEach(() => {
    runWithWorkspace('workspace-a', () => {
      clearConversationMcpSkillApprovals(base.conversationId);
    });
    runWithWorkspace('workspace-b', () => {
      clearConversationMcpSkillApprovals(base.conversationId);
    });
  });

  it('binds approval to workspace, conversation, server, normalized URI, and digest', () => {
    const approval = runWithWorkspace('workspace-a', () => approveMcpSkill(base, 100));
    expect(approval.workspace).toBe('workspace-a');
    expect(approval.skillUri).toBe('skill://pdf-skill/SKILL.md');

    expect(runWithWorkspace('workspace-a', () => getApprovedMcpSkill(base, 101)))
      .toMatchObject({ manifestDigest: DIGEST_A });
    expect(runWithWorkspace('workspace-b', () => getApprovedMcpSkill(base, 101)))
      .toBeUndefined();
    expect(runWithWorkspace('workspace-a', () => getApprovedMcpSkill({
      ...base,
      conversationId: 'other-conversation',
    }, 101))).toBeUndefined();
  });

  it('fails closed after expiry or a manifest digest change', () => {
    const approval = runWithWorkspace('workspace-a', () => approveMcpSkill(base, 100));
    expect(runWithWorkspace('workspace-a', () => getApprovedMcpSkill({
      ...base,
      manifestDigest: DIGEST_B,
    }, 101))).toBeUndefined();

    runWithWorkspace('workspace-a', () => approveMcpSkill(base, 100));
    expect(runWithWorkspace('workspace-a', () => (
      getApprovedMcpSkill(base, approval.expiresAt + 1)
    ))).toBeUndefined();
  });
});
