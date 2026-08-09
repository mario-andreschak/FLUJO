/**
 * Fixed collection names beneath the selected workspace's db directory.
 * Keeping these names centralized makes backup, migrations and deletion
 * previews auditable and avoids accepting a caller-controlled path segment.
 */
export const ENDURING_AGENT_COLLECTIONS = Object.freeze({
  roleDefinitions: 'role-definitions',
  roleVersions: 'role-versions',
  personas: 'personas',
  behaviorBindings: 'persona-behaviors',
  behaviorRevisions: 'behavior-revisions',
  activities: 'persona-activities',
  workItems: 'persona-work-items',
  memoryItems: 'persona-memories',
  mailboxItems: 'persona-mailbox',
  leaseHistory: 'persona-lease-history',
  leases: 'persona-leases',
  deletionTombstones: 'persona-deletion-tombstones',
} as const);

export type EnduringAgentCollection =
  (typeof ENDURING_AGENT_COLLECTIONS)[keyof typeof ENDURING_AGENT_COLLECTIONS];
