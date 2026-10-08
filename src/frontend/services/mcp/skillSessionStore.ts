'use client';

import {
  mcpSkillCacheKey,
  type McpLoadedSkill,
} from '@/shared/types/mcp';

type Listener = () => void;

let activeConversationId: string | null = null;
const skillsByConversation = new Map<string, Map<string, McpLoadedSkill>>();
const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function setActiveMcpSkillConversation(
  conversationId: string | null,
): void {
  activeConversationId = conversationId;
  emitChange();
}

export function getActiveMcpSkillConversation(): string | null {
  return activeConversationId;
}

export function getConversationMcpSkills(
  conversationId: string,
): McpLoadedSkill[] {
  return [...(skillsByConversation.get(conversationId)?.values() ?? [])];
}

export function recordConversationMcpSkill(
  conversationId: string,
  skill: McpLoadedSkill,
): void {
  const current = new Map(skillsByConversation.get(conversationId) ?? []);
  const key = mcpSkillCacheKey(
    skill.identity.serverName,
    skill.identity.skillUri,
    skill.manifest.digest,
  );
  for (const [priorKey, prior] of current) {
    if (
      prior.identity.serverName === skill.identity.serverName &&
      prior.identity.skillUri === skill.identity.skillUri &&
      priorKey !== key
    ) {
      current.delete(priorKey);
    }
  }
  current.set(key, skill);
  skillsByConversation.set(conversationId, current);
  emitChange();
}

/**
 * Drop loaded bytes that no longer appear in a refreshed catalog for a server.
 * Other servers and conversations are intentionally left untouched.
 */
export function reconcileConversationMcpSkills(
  conversationId: string,
  serverName: string,
  validKeys: ReadonlySet<string>,
): void {
  const current = skillsByConversation.get(conversationId);
  if (!current) return;

  let changed = false;
  const next = new Map(current);
  for (const [key, skill] of current) {
    if (skill.identity.serverName !== serverName) continue;
    if (validKeys.has(key)) continue;
    next.delete(key);
    changed = true;
  }
  if (!changed) return;
  if (next.size) skillsByConversation.set(conversationId, next);
  else skillsByConversation.delete(conversationId);
  emitChange();
}

export function clearConversationMcpSkills(conversationId: string): void {
  if (skillsByConversation.delete(conversationId)) emitChange();
}

export function subscribeMcpSkillSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
