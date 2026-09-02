import {
  mcpSkillCacheKey,
  parseMcpSkillUri,
  type McpSkillApproval,
  type McpSkillDigest,
  validateMcpSkillDigest,
} from '@/shared/types/mcp';
import { getCurrentWorkspace } from '@/utils/workspace';

const APPROVAL_TTL_MS = 8 * 60 * 60 * 1000;

declare global {
  var __mcp_skill_approvals: Map<string, McpSkillApproval> | undefined;
}

function approvalStore(): Map<string, McpSkillApproval> {
  global.__mcp_skill_approvals ??= new Map<string, McpSkillApproval>();
  return global.__mcp_skill_approvals;
}

export interface McpSkillApprovalRequest {
  conversationId: string;
  serverName: string;
  skillUri: string;
  manifestDigest: McpSkillDigest;
}

function normalizedRequest(request: McpSkillApprovalRequest): McpSkillApprovalRequest {
  const conversationId = request.conversationId.trim();
  const serverName = request.serverName.trim();
  if (!conversationId || conversationId.length > 512) {
    throw new Error('A valid conversation ID is required to approve an MCP Skill.');
  }
  if (!serverName || serverName.length > 512) {
    throw new Error('A valid MCP server name is required to approve a Skill.');
  }
  return {
    conversationId,
    serverName,
    skillUri: parseMcpSkillUri(request.skillUri).normalizedUri,
    manifestDigest: validateMcpSkillDigest(request.manifestDigest),
  };
}

function approvalIdentity(
  workspace: string,
  request: Omit<McpSkillApprovalRequest, 'manifestDigest'>,
): string {
  return JSON.stringify([
    workspace,
    request.conversationId,
    request.serverName,
    request.skillUri,
  ]);
}

export function approveMcpSkill(
  request: McpSkillApprovalRequest,
  now = Date.now(),
): McpSkillApproval {
  const normalized = normalizedRequest(request);
  const workspace = getCurrentWorkspace();
  const approval: McpSkillApproval = {
    workspace,
    ...normalized,
    approvedAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
  };
  approvalStore().set(approvalIdentity(workspace, normalized), approval);
  return approval;
}

export function getApprovedMcpSkill(
  request: McpSkillApprovalRequest,
  now = Date.now(),
): McpSkillApproval | undefined {
  const normalized = normalizedRequest(request);
  const workspace = getCurrentWorkspace();
  const key = approvalIdentity(workspace, normalized);
  const approval = approvalStore().get(key);
  if (!approval) return undefined;

  const expectedContentIdentity = mcpSkillCacheKey(
    normalized.serverName,
    normalized.skillUri,
    normalized.manifestDigest,
  );
  const approvedContentIdentity = mcpSkillCacheKey(
    approval.serverName,
    approval.skillUri,
    approval.manifestDigest,
  );
  if (
    approval.expiresAt <= now ||
    approval.workspace !== workspace ||
    approval.conversationId !== normalized.conversationId ||
    approvedContentIdentity !== expectedContentIdentity
  ) {
    approvalStore().delete(key);
    return undefined;
  }
  return approval;
}

export function revokeMcpSkillApproval(
  request: McpSkillApprovalRequest,
): void {
  const normalized = normalizedRequest(request);
  const workspace = getCurrentWorkspace();
  approvalStore().delete(approvalIdentity(workspace, normalized));
}

export function clearConversationMcpSkillApprovals(
  conversationId: string,
): void {
  const workspace = getCurrentWorkspace();
  for (const [key, approval] of approvalStore()) {
    if (
      approval.workspace === workspace &&
      approval.conversationId === conversationId
    ) {
      approvalStore().delete(key);
    }
  }
}
