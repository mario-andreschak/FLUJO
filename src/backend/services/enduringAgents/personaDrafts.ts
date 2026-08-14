import {
  CreatePersonaCreationDraftInputSchema,
  DeletePersonaCreationDraftInputSchema,
  PERSONA_CREATION_DRAFT_SCHEMA_VERSION,
  PersonaCreationDraftSchema,
  UpdatePersonaCreationDraftInputSchema,
  type CreatePersonaCreationDraftInput,
  type DeletePersonaCreationDraftInput,
  type PersonaCreationDraft,
  type PersonaCreationDraftPayload,
  type UpdatePersonaCreationDraftInput,
} from '@/shared/types/enduringAgent';
import { getCurrentWorkspace } from '@/utils/workspace';
import {
  assertSafeCollectionId,
  deleteCollectionItem,
  listCollectionItemEntriesStrict,
  loadCollectionItem,
  runInWriteChain,
  saveCollectionItem,
} from '@/utils/storage/backend';

import { canonicalJson } from './behaviorRevisions';
import { ENDURING_AGENT_COLLECTIONS } from './collections';
import { randomEnduringAgentId } from './ids';

export type PersonaDraftConflictReason = 'ALREADY_EXISTS' | 'STALE_REVISION';

export class PersonaDraftNotFoundError extends Error {
  readonly code = 'PERSONA_DRAFT_NOT_FOUND' as const;

  constructor(readonly draftId: string) {
    super(`Persona draft ${JSON.stringify(draftId)} was not found.`);
    this.name = 'PersonaDraftNotFoundError';
  }
}

export class PersonaDraftConflictError extends Error {
  readonly code = 'PERSONA_DRAFT_CONFLICT' as const;

  constructor(
    message: string,
    readonly details: {
      reason: PersonaDraftConflictReason;
      currentRevision?: number;
    },
  ) {
    super(message);
    this.name = 'PersonaDraftConflictError';
  }
}

function draftMutation<T>(draftId: string, task: () => Promise<T>): Promise<T> {
  assertSafeCollectionId(draftId);
  return runInWriteChain(
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.personaCreationDrafts}/${draftId}`,
    task,
  );
}

function parseDraft(value: unknown): PersonaCreationDraft {
  return PersonaCreationDraftSchema.parse(value);
}

function assertCurrentWorkspace(draft: PersonaCreationDraft): PersonaCreationDraft {
  const workspaceId = getCurrentWorkspace();
  if (draft.workspaceId !== workspaceId) {
    throw new Error(
      `Persona draft ${JSON.stringify(draft.id)} belongs to workspace `
      + `${JSON.stringify(draft.workspaceId)}, not ${JSON.stringify(workspaceId)}.`,
    );
  }
  return draft;
}

function samePayload(
  left: PersonaCreationDraftPayload,
  right: PersonaCreationDraftPayload,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function readDraftRecord(draftId: string): Promise<PersonaCreationDraft | null> {
  assertSafeCollectionId(draftId);
  const value = await loadCollectionItem<unknown | null>(
    ENDURING_AGENT_COLLECTIONS.personaCreationDrafts,
    draftId,
    null,
  );
  if (value === null) return null;
  const draft = assertCurrentWorkspace(parseDraft(value));
  if (draft.id !== draftId) {
    throw new Error(
      `Persona draft storage id ${JSON.stringify(draftId)} does not match record id `
      + `${JSON.stringify(draft.id)}.`,
    );
  }
  return draft;
}

export function getPersonaCreationDraft(
  draftId: string,
): Promise<PersonaCreationDraft | null> {
  return readDraftRecord(draftId);
}

export async function listPersonaCreationDrafts(): Promise<PersonaCreationDraft[]> {
  const entries = await listCollectionItemEntriesStrict<unknown>(
    ENDURING_AGENT_COLLECTIONS.personaCreationDrafts,
  );
  return entries.map(({ id, item }) => {
    const draft = assertCurrentWorkspace(parseDraft(item));
    if (draft.id !== id) {
      throw new Error(
        `Persona draft storage id ${JSON.stringify(id)} does not match record id `
        + `${JSON.stringify(draft.id)}.`,
      );
    }
    return draft;
  }).sort((left, right) => (
    right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
  ));
}

export async function createPersonaCreationDraft(
  value: unknown,
): Promise<PersonaCreationDraft> {
  const input = CreatePersonaCreationDraftInputSchema.parse(
    value,
  ) as CreatePersonaCreationDraftInput;
  const draftId = input.id ?? randomEnduringAgentId('draft');
  const workspaceId = getCurrentWorkspace();

  return draftMutation(draftId, async () => {
    const existing = await readDraftRecord(draftId);
    if (existing) {
      if (samePayload(existing.payload, input.payload)) return existing;
      throw new PersonaDraftConflictError(
        `Persona draft ${JSON.stringify(draftId)} already exists.`,
        { reason: 'ALREADY_EXISTS', currentRevision: existing.revision },
      );
    }

    const now = Date.now();
    const draft = PersonaCreationDraftSchema.parse({
      schemaVersion: PERSONA_CREATION_DRAFT_SCHEMA_VERSION,
      id: draftId,
      workspaceId,
      status: 'draft',
      payload: input.payload,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await saveCollectionItem(
      ENDURING_AGENT_COLLECTIONS.personaCreationDrafts,
      draft.id,
      draft,
    );
    return draft;
  });
}

export async function updatePersonaCreationDraft(
  draftId: string,
  value: unknown,
): Promise<PersonaCreationDraft> {
  const input = UpdatePersonaCreationDraftInputSchema.parse(
    value,
  ) as UpdatePersonaCreationDraftInput;

  return draftMutation(draftId, async () => {
    const existing = await readDraftRecord(draftId);
    if (!existing) throw new PersonaDraftNotFoundError(draftId);

    if (
      input.expectedRevision === existing.revision
      && samePayload(existing.payload, input.payload)
    ) {
      return existing;
    }

    // A retry after a successful update carries the previous expected revision.
    if (
      input.expectedRevision === existing.revision - 1
      && samePayload(existing.payload, input.payload)
    ) {
      return existing;
    }

    if (input.expectedRevision !== existing.revision) {
      throw new PersonaDraftConflictError(
        'This Persona draft changed elsewhere. Reload it and try again.',
        {
          reason: 'STALE_REVISION',
          currentRevision: existing.revision,
        },
      );
    }

    const updated = PersonaCreationDraftSchema.parse({
      ...existing,
      payload: input.payload,
      revision: existing.revision + 1,
      updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
    });
    await saveCollectionItem(
      ENDURING_AGENT_COLLECTIONS.personaCreationDrafts,
      updated.id,
      updated,
    );
    return updated;
  });
}

export async function deletePersonaCreationDraft(
  draftId: string,
  value: unknown,
): Promise<void> {
  const input = DeletePersonaCreationDraftInputSchema.parse(
    value,
  ) as DeletePersonaCreationDraftInput;

  await draftMutation(draftId, async () => {
    const existing = await readDraftRecord(draftId);
    if (!existing) return;
    if (input.expectedRevision !== existing.revision) {
      throw new PersonaDraftConflictError(
        'This Persona draft changed elsewhere. Reload it before discarding it.',
        {
          reason: 'STALE_REVISION',
          currentRevision: existing.revision,
        },
      );
    }
    await deleteCollectionItem(
      ENDURING_AGENT_COLLECTIONS.personaCreationDrafts,
      draftId,
    );
  });
}
