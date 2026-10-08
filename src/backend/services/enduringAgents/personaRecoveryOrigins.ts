import { PersonaRecoveryError } from './personaRecoveryError';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PersonaDeletionTombstoneSchema, type PersonaDeletionTombstone } from '@/shared/types/enduringAgent';
import { assertValidWorkspaceName, getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { PersonaRecoveryFileReader } from './personaRecoveryFiles';
import { canonicalJson } from './behaviorRevisions';
import { personaDeletionTombstoneId } from './ids';

export const PERSONA_RECOVERY_ORIGIN_PATH = 'evidence/recovery-origin.json';
export const PersonaRecoveryOriginsSchema = z.object({
  id: z.literal('origin'), version: z.literal(1),
  tombstones: z.array(PersonaDeletionTombstoneSchema).max(60_000),
}).strict().superRefine((value, context) => {
  const identities = new Set<string>();
  for (const record of value.tombstones) {
    let validWorkspace = true;
    try { assertValidWorkspaceName(record.workspaceId); } catch { validWorkspace = false; }
    const key = `${record.workspaceId.toLowerCase()}/${record.id.toLowerCase()}`;
    if (!validWorkspace || record.status !== 'completed' || identities.has(key)
      || (record.retainedPersonaId !== undefined && (
        record.id !== personaDeletionTombstoneId(record.workspaceId, record.retainedPersonaId)
        || record.personaIdHash !== recoveryPersonaHash(record.workspaceId, record.retainedPersonaId)
      ))) context.addIssue({ code: 'custom', message: 'Invalid or duplicate recovery deletion origin.' });
    identities.add(key);
  }
});
export type PersonaRecoveryOrigins = z.infer<typeof PersonaRecoveryOriginsSchema>;

export function recoveryPersonaHash(workspace: string, personaId: string): string {
  return createHash('sha256').update(`${workspace}\0${personaId}`).digest('hex');
}

export function mergePersonaRecoveryOrigins(records: readonly PersonaDeletionTombstone[]): PersonaRecoveryOrigins {
  const unique = new Map<string, PersonaDeletionTombstone>();
  for (const record of records) {
    const key = `${record.workspaceId.toLowerCase()}/${record.id.toLowerCase()}`;
    const previous = unique.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(record)) throw new PersonaRecoveryError('Conflicting recovery deletion origins.');
    unique.set(key, record);
  }
  return PersonaRecoveryOriginsSchema.parse({ id: 'origin', version: 1, tombstones: [...unique.values()]
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.id.localeCompare(b.id)) });
}

/** Only examine origin evidence physically installed in the selected workspace. */
export async function getRecoveredPersonaDeletionTombstone(personaId: string): Promise<PersonaDeletionTombstone | null> {
  const reader = new PersonaRecoveryFileReader(getWorkspaceDataDir());
  const stored = await reader.read('db/persona-recovery/origin.json');
  if (!stored) {
    if (await reader.read('db/persona-recovery/restore.json')) throw new PersonaRecoveryError('Recovery deletion origins are missing.');
    return null;
  }
  // Empty/corrupt files must not be treated as an absent tombstone collection.
  // The ordinary collection loader intentionally treats empty files as absent.
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored)); }
  catch { throw new PersonaRecoveryError('Recovery deletion origins are invalid.'); }
  const origins = PersonaRecoveryOriginsSchema.parse(value);
  await reader.verifyUnchanged();
  const previous = origins.tombstones.find((record) => record.personaIdHash === recoveryPersonaHash(record.workspaceId, personaId));
  if (!previous) return null;
  if (previous.id !== personaDeletionTombstoneId(previous.workspaceId, personaId)) throw new PersonaRecoveryError('Recovery deletion identity mismatch.');
  const workspaceId = getCurrentWorkspace();
  // Anonymous hashes cannot be inverted during restore. Project a matching
  // original tombstone only when the requested identity is available, keeping
  // anti-resurrection semantics without importing another workspace's authority.
  return PersonaDeletionTombstoneSchema.parse({
    ...previous, workspaceId, id: personaDeletionTombstoneId(workspaceId, personaId),
    personaIdHash: recoveryPersonaHash(workspaceId, personaId),
  });
}
