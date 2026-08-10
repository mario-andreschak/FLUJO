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
  appGrants: 'persona-app-grants',
  activities: 'persona-activities',
  workItems: 'persona-work-items',
  memoryItems: 'persona-memories',
  mailboxItems: 'persona-mailbox',
  /** Private, strict-versioned Flow inputs referenced by Persona mailbox items. */
  flowDispatches: 'persona-flow-dispatches',
  /** Private transactional outbox for explicit runtime-recovery observations. */
  runtimeRecoveryReceipts: 'persona-runtime-recovery-receipts',
  leaseHistory: 'persona-lease-history',
  leases: 'persona-leases',
  deletionTombstones: 'persona-deletion-tombstones',
} as const);

export type EnduringAgentCollection =
  (typeof ENDURING_AGENT_COLLECTIONS)[keyof typeof ENDURING_AGENT_COLLECTIONS];
