import { z } from 'zod';

import {
  CreateMemoryItemInputSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  EnduringAgentIdSchema,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TRUST_LEVELS,
  MemoryItemSchema,
  MemorySourceRefSchema,
  type CreateMemoryItemInput,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
  type MemoryTrust,
  type Persona,
} from '@/shared/types/enduringAgent';

import {
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
  type PersonaDomainMutationOptions,
  withPersonaDomainMutation,
} from './domainMutation';
import { randomEnduringAgentId } from './ids';
import { normalizeMemorySourceRefs } from './provenance';
import {
  getMemoryItem,
  getPersona,
  getRoleVersion,
  listMemoryItems,
  saveMemoryItem,
} from './store';

const MemorySearchQuerySchema = z.object({
  query: z.string().trim().max(2_000).optional(),
  kinds: z.array(z.enum(MEMORY_KINDS)).optional(),
  scopes: z.array(z.enum(MEMORY_SCOPES)).optional(),
  statuses: z.array(z.enum(MEMORY_STATUSES)).optional(),
  trust: z.array(z.enum(MEMORY_TRUST_LEVELS)).optional(),
  coreOnly: z.boolean().optional(),
  asOf: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

const CorrectMemoryInputSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  sourceRefs: z.array(MemorySourceRefSchema).min(1).max(100),
  validFrom: z.number().int().nonnegative().optional(),
  validUntil: z.number().int().nonnegative().optional(),
  expectedUpdatedAt: z.number().int().nonnegative().optional(),
}).strict();

export interface MemoryMutationOptions extends PersonaDomainMutationOptions {
  /** Explicit local review gate for activating model-inferred candidates. */
  reviewed?: boolean;
}

export interface MemorySearchQuery {
  query?: string;
  kinds?: MemoryKind[];
  scopes?: MemoryScope[];
  statuses?: MemoryStatus[];
  trust?: MemoryTrust[];
  coreOnly?: boolean;
  asOf?: number;
  limit?: number;
}

export interface MemorySearchResult {
  item: MemoryItem;
  score: number;
  core: boolean;
}

export interface CorrectMemoryInput {
  content: string;
  confidence?: number;
  importance?: number;
  sourceRefs: CreateMemoryItemInput['sourceRefs'];
  validFrom?: number;
  validUntil?: number;
  expectedUpdatedAt?: number;
}

function assertPersonaMayChangeMemory(
  persona: Persona,
  options: PersonaDomainMutationOptions,
): void {
  if (options.executionAuthority && persona.autonomyLevel === 'locked') {
    throw new PersonaDomainConflictError(
      'Automatic memory changes are turned off for this Persona.',
      'PERSONA_LEARNING_DISABLED',
      { reason: 'learning_disabled' },
    );
  }
}

function stableSourceRefValue(memory: MemoryItem): string {
  return JSON.stringify(memory.sourceRefs.map(({ observedAt: _observedAt, ...sourceRef }) => sourceRef));
}

function requireOwnedMemory(item: MemoryItem | null, personaId: string, requestedId: string): MemoryItem {
  if (!item || item.personaId !== personaId) {
    throw new PersonaDomainNotFoundError('MemoryItem', requestedId);
  }
  return item;
}

function assertActivationPolicy(
  trust: MemoryTrust,
  status: 'candidate' | 'active',
  options: MemoryMutationOptions,
  sourceKinds: readonly string[],
): void {
  if (status !== 'active') return;
  if (trust === 'external_untrusted') {
    throw new PersonaDomainConflictError('Untrusted external content cannot be activated.');
  }
  if (trust === 'model_inference' && !options.reviewed) {
    throw new PersonaDomainConflictError('Model-inferred memory requires explicit review before activation.');
  }
  if (trust === 'explicit_user' && !sourceKinds.includes('user_statement')) {
    throw new PersonaDomainConflictError('Explicit-user memory requires user-statement provenance.');
  }
  if (trust === 'verified_tool' && !sourceKinds.includes('tool_result')) {
    throw new PersonaDomainConflictError('Verified-tool memory requires tool-result provenance.');
  }
}

async function createMemoryWithinMutation(
  input: CreateMemoryItemInput,
  options: MemoryMutationOptions,
  activityId?: string,
): Promise<MemoryItem> {
  const now = Date.now();
  const invokedByFlow = Boolean(options.executionAuthority);
  const trust: MemoryTrust = invokedByFlow ? 'model_inference' : input.trust;
  const status: 'candidate' | 'active' = invokedByFlow ? 'candidate' : input.status ?? 'candidate';
  const refs = [...input.sourceRefs];
  if (activityId && !refs.some((ref) => ref.kind === 'activity' && ref.id === activityId)) {
    refs.push({ kind: 'activity', id: activityId, observedAt: now });
  }
  assertActivationPolicy(trust, status, options, refs.map((ref) => ref.kind));
  const record = MemoryItemSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id: input.id ?? randomEnduringAgentId('memory'),
    personaId: input.personaId,
    kind: input.kind,
    scope: input.scope,
    status,
    content: input.content,
    confidence: input.confidence,
    importance: input.importance,
    sourceRefs: normalizeMemorySourceRefs(refs, {
      now,
      producer: invokedByFlow ? 'persona-flow-proposal' : undefined,
      digestMaterial: input.content,
    }),
    trust,
    ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
    ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    ...(input.supersedes?.length ? { supersedes: input.supersedes } : {}),
    ...(input.conflictsWith?.length ? { conflictsWith: input.conflictsWith } : {}),
    createdAt: now,
    updatedAt: now,
  }) as MemoryItem;
  const existing = await getMemoryItem(record.id);
  if (existing) {
    const sameSemanticValue = existing.personaId === record.personaId
      && existing.kind === record.kind
      && existing.scope === record.scope
      && existing.status === record.status
      && existing.content === record.content
      && existing.confidence === record.confidence
      && existing.importance === record.importance
      && existing.trust === record.trust
      // observedAt records when this attempt saw the evidence. It may legitimately
      // differ on an idempotent retry and is not part of the memory's identity.
      && stableSourceRefValue(existing) === stableSourceRefValue(record)
      && JSON.stringify(existing.supersedes ?? []) === JSON.stringify(record.supersedes ?? [])
      && JSON.stringify(existing.conflictsWith ?? []) === JSON.stringify(record.conflictsWith ?? []);
    if (sameSemanticValue) return existing;
    throw new PersonaDomainConflictError(`MemoryItem ${JSON.stringify(record.id)} already exists.`);
  }
  return saveMemoryItem(record);
}

/**
 * Trusted storage boundary for a validated memory candidate.
 *
 * Model-facing callers should use the `remember` Persona tool instead of
 * invoking this operation directly. Keeping the mutation name distinct from
 * the proposal tool makes the trust boundary explicit while the compatibility
 * wrapper below preserves the existing service API.
 */
export async function storeMemoryCandidate(
  input: CreateMemoryItemInput,
  options: MemoryMutationOptions = {},
): Promise<MemoryItem> {
  const parsed = CreateMemoryItemInputSchema.parse(input) as CreateMemoryItemInput;
  return withPersonaDomainMutation(parsed.personaId, options, ({ persona, activity }) => {
    assertPersonaMayChangeMemory(persona, options);
    return createMemoryWithinMutation(parsed, options, activity?.id);
  });
}

/** @deprecated Prefer `storeMemoryCandidate` for new internal persistence code. */
export async function rememberMemory(
  input: CreateMemoryItemInput,
  options: MemoryMutationOptions = {},
): Promise<MemoryItem> {
  return storeMemoryCandidate(input, options);
}

export async function getPersonaMemory(personaId: string, memoryId: string): Promise<MemoryItem> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(memoryId);
  return requireOwnedMemory(await getMemoryItem(memoryId), personaId, memoryId);
}

function queryTerms(query: string | undefined): string[] {
  return [...new Set((query?.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []))];
}

function lexicalScore(item: MemoryItem, terms: readonly string[]): number {
  const content = item.content.toLocaleLowerCase();
  let score = item.importance * 0.25 + item.confidence * 0.15;
  for (const term of terms) {
    if (content === term) score += 4;
    else if (content.includes(term)) score += 1;
  }
  return score;
}

export async function searchPersonaMemory(
  personaId: string,
  query: MemorySearchQuery = {},
): Promise<MemorySearchResult[]> {
  EnduringAgentIdSchema.parse(personaId);
  const parsed = MemorySearchQuerySchema.parse(query) as MemorySearchQuery;
  const persona = await getPersona(personaId);
  if (!persona) throw new PersonaDomainNotFoundError('Persona', personaId);
  const coreIds = new Set(persona.coreMemoryItemIds ?? []);
  const terms = queryTerms(parsed.query);
  const asOf = parsed.asOf ?? Date.now();
  const defaultStatuses: MemoryStatus[] = ['active'];
  return (await listMemoryItems(personaId)).filter((item) => (
    (parsed.statuses ?? defaultStatuses).includes(item.status)
    && (!parsed.kinds?.length || parsed.kinds.includes(item.kind))
    && (!parsed.scopes?.length || parsed.scopes.includes(item.scope))
    && (!parsed.trust?.length || parsed.trust.includes(item.trust))
    && (!parsed.coreOnly || coreIds.has(item.id))
    && (item.validFrom === undefined || item.validFrom <= asOf)
    && (item.validUntil === undefined || item.validUntil >= asOf)
    && (terms.length === 0 || terms.some((term) => item.content.toLocaleLowerCase().includes(term)))
  )).map((item) => ({
    item,
    core: coreIds.has(item.id),
    score: lexicalScore(item, terms) + (coreIds.has(item.id) ? 2 : 0),
  })).sort((left, right) => (
    right.score - left.score
    || right.item.updatedAt - left.item.updatedAt
    || left.item.id.localeCompare(right.item.id)
  )).slice(0, parsed.limit ?? 50);
}

export async function correctMemory(
  personaId: string,
  memoryId: string,
  input: CorrectMemoryInput,
  options: MemoryMutationOptions = {},
): Promise<MemoryItem> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(memoryId);
  const parsed = CorrectMemoryInputSchema.parse(input) as CorrectMemoryInput;
  return withPersonaDomainMutation(personaId, options, async ({ persona, activity, updatePersona }) => {
    assertPersonaMayChangeMemory(persona, options);
    const original = requireOwnedMemory(await getMemoryItem(memoryId), personaId, memoryId);
    if (original.status === 'forgotten') {
      throw new PersonaDomainConflictError('Forgotten memory cannot be corrected in place.');
    }
    if (parsed.expectedUpdatedAt !== undefined && parsed.expectedUpdatedAt !== original.updatedAt) {
      throw new PersonaDomainConflictError(
        'Memory changed since it was inspected.',
        'memory_changed',
        { currentUpdatedAt: original.updatedAt },
      );
    }
    const invokedByFlow = Boolean(options.executionAuthority);
    const correction = await createMemoryWithinMutation({
      personaId,
      kind: original.kind,
      scope: original.scope,
      status: invokedByFlow ? 'candidate' : 'active',
      content: parsed.content,
      confidence: parsed.confidence ?? original.confidence,
      importance: parsed.importance ?? original.importance,
      sourceRefs: parsed.sourceRefs,
      trust: invokedByFlow ? 'model_inference' : 'explicit_user',
      ...(parsed.validFrom !== undefined ? { validFrom: parsed.validFrom } : {}),
      ...(parsed.validUntil !== undefined ? { validUntil: parsed.validUntil } : {}),
      supersedes: [original.id],
    }, options, activity?.id);

    if (correction.status !== 'active') return correction;
    const wasCore = persona.coreMemoryItemIds?.includes(original.id) ?? false;
    if (wasCore) {
      await updatePersona({
        ...persona,
        coreMemoryItemIds: (persona.coreMemoryItemIds ?? []).map(
          (id) => id === original.id ? correction.id : id,
        ),
        updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
      });
    }
    await saveMemoryItem({
      ...original,
      status: 'superseded',
      updatedAt: Math.max(Date.now(), original.updatedAt + 1),
    });
    return correction;
  });
}

export async function activateMemory(
  personaId: string,
  memoryId: string,
  options: MemoryMutationOptions = {},
): Promise<MemoryItem> {
  if (options.executionAuthority) {
    throw new PersonaDomainConflictError('A model-run tool cannot review and activate memory.');
  }
  return withPersonaDomainMutation(personaId, options, async ({ persona, updatePersona }) => {
    const item = requireOwnedMemory(await getMemoryItem(memoryId), personaId, memoryId);
    if (item.status === 'active') return item;
    if (item.status !== 'candidate') {
      throw new PersonaDomainConflictError('Only a candidate MemoryItem can be activated.');
    }
    assertActivationPolicy(item.trust, 'active', { ...options, reviewed: true }, item.sourceRefs.map((ref) => ref.kind));
    const activated = await saveMemoryItem({
      ...item,
      status: 'active',
      updatedAt: Math.max(Date.now(), item.updatedAt + 1),
    });
    const supersededIds = new Set(item.supersedes ?? []);
    if (supersededIds.size > 0) {
      const nextCore = (persona.coreMemoryItemIds ?? []).filter((id) => !supersededIds.has(id));
      if (nextCore.length !== (persona.coreMemoryItemIds ?? []).length) {
        await updatePersona({
          ...persona,
          coreMemoryItemIds: nextCore,
          updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
        });
      }
      for (const id of supersededIds) {
        const prior = await getMemoryItem(id);
        if (prior?.personaId === personaId && prior.status !== 'forgotten') {
          await saveMemoryItem({
            ...prior,
            status: 'superseded',
            updatedAt: Math.max(Date.now(), prior.updatedAt + 1),
          });
        }
      }
    }
    return activated;
  });
}

export async function forgetMemory(
  personaId: string,
  memoryId: string,
  options: PersonaDomainMutationOptions = {},
): Promise<MemoryItem> {
  return withPersonaDomainMutation(personaId, options, async ({ persona, updatePersona }) => {
    assertPersonaMayChangeMemory(persona, options);
    const item = requireOwnedMemory(await getMemoryItem(memoryId), personaId, memoryId);
    if (item.status === 'forgotten') return item;
    if (persona.coreMemoryItemIds?.includes(item.id)) {
      await updatePersona({
        ...persona,
        coreMemoryItemIds: persona.coreMemoryItemIds.filter((id) => id !== item.id),
        updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
      });
    }
    return saveMemoryItem({
      ...item,
      status: 'forgotten',
      updatedAt: Math.max(Date.now(), item.updatedAt + 1),
    });
  });
}

export async function pinMemoryToCore(
  personaId: string,
  memoryId: string,
  options: PersonaDomainMutationOptions = {},
): Promise<MemoryItem[]> {
  return withPersonaDomainMutation(personaId, options, async ({ persona, updatePersona }) => {
    assertPersonaMayChangeMemory(persona, options);
    const item = requireOwnedMemory(await getMemoryItem(memoryId), personaId, memoryId);
    if (item.status !== 'active' || (item.trust !== 'explicit_user' && item.trust !== 'verified_tool')) {
      throw new PersonaDomainConflictError('Core memory requires active explicit-user or verified-tool trust.');
    }
    const ids = [...new Set([...(persona.coreMemoryItemIds ?? []), item.id])];
    const role = await getRoleVersion(persona.roleVersionId);
    const maxItems = role?.defaults?.memory?.coreMemoryMaxItems ?? 32;
    if (ids.length > maxItems) {
      throw new PersonaDomainConflictError(
        `Core memory is limited to ${maxItems} items.`,
        'core_memory_capacity',
        {
          maxCoreItems: maxItems,
          currentCoreItems: persona.coreMemoryItemIds?.length ?? 0,
        },
      );
    }
    if (ids.length !== (persona.coreMemoryItemIds ?? []).length) {
      await updatePersona({
        ...persona,
        coreMemoryItemIds: ids,
        updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
      });
    }
    const byId = new Map((await listMemoryItems(personaId)).map((memory) => [memory.id, memory]));
    return ids.map((id) => byId.get(id)).filter((memory): memory is MemoryItem => Boolean(memory));
  });
}

export async function unpinMemoryFromCore(
  personaId: string,
  memoryId: string,
  options: PersonaDomainMutationOptions = {},
): Promise<MemoryItem[]> {
  return withPersonaDomainMutation(personaId, options, async ({ persona, updatePersona }) => {
    assertPersonaMayChangeMemory(persona, options);
    requireOwnedMemory(await getMemoryItem(memoryId), personaId, memoryId);
    const ids = (persona.coreMemoryItemIds ?? []).filter((id) => id !== memoryId);
    if (ids.length !== (persona.coreMemoryItemIds ?? []).length) {
      await updatePersona({
        ...persona,
        coreMemoryItemIds: ids,
        updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
      });
    }
    const byId = new Map((await listMemoryItems(personaId)).map((memory) => [memory.id, memory]));
    return ids.map((id) => byId.get(id)).filter((memory): memory is MemoryItem => Boolean(memory));
  });
}

export async function getCoreMemory(personaId: string): Promise<MemoryItem[]> {
  const persona = await getPersona(personaId);
  if (!persona) throw new PersonaDomainNotFoundError('Persona', personaId);
  const coreMemoryItemIds = persona.coreMemoryItemIds ?? [];
  if (coreMemoryItemIds.length === 0) return [];

  const byId = new Map((await listMemoryItems(personaId)).map((memory) => [memory.id, memory]));
  return coreMemoryItemIds
    .map((id) => byId.get(id))
    .filter((item): item is MemoryItem => Boolean(item));
}
