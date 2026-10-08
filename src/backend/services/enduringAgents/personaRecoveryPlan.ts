import { PersonaRecoveryError } from './personaRecoveryError';
import { createHash } from 'node:crypto';
import {
  PersonaActivitySchema, PersonaSchema, PersonaWorkItemSchema, BehaviorMaintenanceRunSchema,
  type PersonaDeletionTombstone,
} from '@/shared/types/enduringAgent';
import { assertValidWorkspaceName } from '@/utils/workspace';
import { PERSONA_SHARDED_COLLECTIONS } from '@/utils/storage/backend';
import { canonicalJson } from './behaviorRevisions';
import { ENDURING_AGENT_COLLECTIONS as c } from './collections';
import { validatePersonaRecoveryArchive } from './personaRecoveryArchive';
import { decodePersonaRecoveryZip, type PersonaRecoveryZipFile } from './personaRecoveryZip';
import { mergePersonaRecoveryOrigins } from './personaRecoveryOrigins';
import type { PersonaRecoveryRestorePreview } from '@/shared/types/personaRecovery';

export type { PersonaRecoveryRestorePreview } from '@/shared/types/personaRecovery';
export interface PersonaRecoveryRestorePlan {
  preview: PersonaRecoveryRestorePreview;
  /** Fixed, validated destinations relative to a private staging workspace. */
  files: PersonaRecoveryZipFile[];
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sharded = new Set<string>(PERSONA_SHARDED_COLLECTIONS);

/** Pure, deterministic preflight. No destination file is touched until this succeeds. */
export function planPersonaRecoveryRestore(archive: Buffer, destinationWorkspace: string): PersonaRecoveryRestorePlan {
  assertValidWorkspaceName(destinationWorkspace);
  // Detach from caller-owned memory before parsing or retaining the evidence.
  const original = Buffer.from(archive);
  const recovery = validatePersonaRecoveryArchive(decodePersonaRecoveryZip(original));
  if (destinationWorkspace.toLowerCase() === recovery.manifest.sourceWorkspace.toLowerCase()) {
    throw new PersonaRecoveryError('Persona recovery requires a new workspace name; it never overwrites the source.');
  }
  const files: PersonaRecoveryZipFile[] = [];
  const changes: Record<string, number> = {};
  const restoredCounts: Record<string, number> = {};
  const sourceFiles = new Map(recovery.files.map((file) => [file.path, file.bytes]));
  const changed = (reason: string) => { changes[reason] = (changes[reason] ?? 0) + 1; };
  for (const record of recovery.graph.records) {
    if (record.evidenceOnly || record.collection === c.deletionTombstones) {
      changed('records_kept_as_recovery_evidence');
      continue;
    }
    let value = record.parsed;
    const sourcePath = sharded.has(record.collection)
      ? `records/${record.collection}/${value.personaId}/${record.id}.json`
      : `records/${record.collection}/${record.id}.json`;
    let bytes = Buffer.from(sourceFiles.get(sourcePath) ?? sourceFiles.get(`records/${record.collection}/${record.id}.json`)!);
    const at = Math.max(recovery.manifest.capturedAt, Number(value.updatedAt ?? value.createdAt ?? 0)) + 1;
    if (record.collection === c.personas) {
      value = PersonaSchema.parse({
        ...value, lifecycleState: 'disabled', autonomyLevel: 'locked', updatedAt: at,
        composition: value.composition ? { ...(value.composition as object), appRefs: [] } : undefined,
      });
      changed('personas_disabled_and_learning_locked');
      bytes = json(value);
    } else if (record.collection === c.workItems) {
      value = structuredClone(value);
      if (value.goal) {
        const goal = value.goal as Record<string, unknown>;
        for (const key of Object.keys(goal)) if (key.startsWith('pending') || key === 'nextRunAt') delete goal[key];
        if (goal.state !== 'completed' && goal.state !== 'stopped') { goal.state = 'paused'; changed('goals_paused'); }
      }
      if (value.status === 'in_progress') { value.status = 'open'; changed('interrupted_tasks_returned_to_backlog'); }
      if (value.parentGoalId && value.status !== 'completed' && value.status !== 'cancelled') value.goalControlState = 'paused';
      delete value.revokedGoalDispatchId;
      value.updatedAt = at;
      value = PersonaWorkItemSchema.parse(value);
      bytes = json(value);
    } else if (record.collection === c.activities && !['completed', 'cancelled', 'error'].includes(String(value.status))) {
      value = PersonaActivitySchema.parse({
        ...value, status: 'cancelled', completedAt: at, updatedAt: at,
        interruptionRequestedAt: undefined, interruptionRequestedByMailboxItemId: undefined,
      });
      changed('unfinished_activities_cancelled');
      bytes = json(value);
    } else if (record.collection === c.behaviorMaintenanceRuns && !['completed', 'failed', 'cancelled', 'awaiting_review'].includes(String(value.state))) {
      value = BehaviorMaintenanceRunSchema.parse({
        ...value, state: 'cancelled', completedAt: at, updatedAt: at,
        diagnosisLeaseId: undefined, diagnosisLeaseExpiresAt: undefined, reasonCode: 'recovery_requires_review',
      });
      changed('unfinished_maintenance_cancelled');
      bytes = json(value);
    }
    const relative = sharded.has(record.collection)
      ? `db/${record.collection}/${value.personaId}/${record.id}.json`
      : `db/${record.collection}/${record.id}.json`;
    files.push({ path: relative, bytes });
    restoredCounts[record.collection] = (restoredCounts[record.collection] ?? 0) + 1;
  }
  for (const file of recovery.files) {
    const kind = file.path.split('/')[0];
    if (kind === 'flows' || kind === 'flow-versions' || kind === 'model-turns' || kind === 'conversation-logs') {
      files.push({ path: `db/${file.path}`, bytes: Buffer.from(file.bytes) });
    } else if (kind === 'home') {
      files.push({ path: file.path.replace('home/', 'userdata/personas/'), bytes: Buffer.from(file.bytes) });
    }
  }
  for (const [conversationId, originalState] of recovery.conversations) {
    const state = structuredClone(originalState);
    // Old conversation evidence remains readable. The archive bit is enforced
    // by the ordinary conversation API, including follow-ups and debug resume.
    state.personaArchived = true;
    for (const key of ['executionAuthority', 'personaCoreAppRefs', 'codexSessions', 'recovery',
      'activeSubflowInvocationByNode', 'subflowSessions', 'meetingTurn', 'mcpSkillSelections']) delete state[key];
    if (!['completed', 'error', 'capped'].includes(String(state.status))) state.status = 'error';
    files.push({ path: `db/conversations/${conversationId}.json`, bytes: json(state) });
    changed('conversations_made_read_only');
  }
  const origins = mergePersonaRecoveryOrigins([
    ...recovery.origins.tombstones,
    ...recovery.graph.records.filter((record) => record.collection === c.deletionTombstones)
      .map((record) => record.parsed as unknown as PersonaDeletionTombstone),
  ]);
  files.push({ path: 'db/persona-recovery/origin.json', bytes: json(origins) });
  // Retain the exact source archive, including the unmodified private records
  // and all excluded live queues/grants/leases. It is never extracted as work.
  files.push({ path: 'db/persona-recovery/source.zip', bytes: original });
  const details = {
    sourceWorkspace: recovery.manifest.sourceWorkspace, destinationWorkspace,
    captureId: recovery.manifest.captureId, capturedAt: recovery.manifest.capturedAt,
    archiveSha256: digest(original), archiveBytes: original.length,
    sourceCounts: recovery.counts, restoredCounts, changes,
    requiredModelIds: recovery.requiredModelIds, requiredAppNames: recovery.requiredAppNames,
  };
  const previewToken = digest(json({ ...details, files: files.map((file) => ({ path: file.path, sha256: digest(file.bytes) })) }));
  const preview: PersonaRecoveryRestorePreview = { ...details, previewToken };
  files.push({ path: 'db/persona-recovery/restore.json', bytes: Buffer.from(canonicalJson({ version: 1, ...preview })) });
  return { preview, files };
}
