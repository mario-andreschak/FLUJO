import { z } from 'zod';

import { FEATURES } from '@/config/features';
import { modelService } from '@/backend/services/model';
import { getEmbeddingProvider } from '@/backend/services/model/embeddings';
import { supportsEmbeddings } from '@/shared/types/model/embeddings';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';
import {
  CreateMemoryItemInputSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  ResolveMemoryConflictInputSchema,
  EnduringAgentIdSchema,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TRUST_LEVELS,
  MemoryItemSchema,
  MemorySourceRefSchema,
  type ConflictResolutionAudit,
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
import { buildReinforcedMemoryItem } from './memoryDeduplication';
import {
  buildSemanticMemoryScores,
  listPersonaEmbeddings,
  type SemanticMemoryScore,
} from './memoryEmbeddingStore';
import {
  recordSemanticRecallCandidates,
  recordSemanticRecallFallback,
  recordSemanticRecallStage,
} from './memoryRecallMetrics';
import { getMemoryQueryVectorCache } from './memoryQueryVectorCache';
import { getMemorySettings } from './memorySettings';
import {
  MEMORY_DEDUP_SETTINGS,
  MEMORY_RANKING_WEIGHTS,
  MEMORY_SEMANTIC_FLOOR,
  scoreMemoryCandidate,
  semanticCandidateEligible,
  selectNearDuplicateCandidate,
} from './memoryRanking';
import { lexicalRelationScorer } from './memorySimilarity';
import {
  compareMemoryReviewCandidates,
  memoryReviewScore,
} from './memoryReviewRanking';
import { normalizeMemorySourceRefs } from './provenance';
import {
  getMemoryItem,
  getPersona,
  getRoleVersion,
  listMemoryItems,
  saveMemoryItem,
} from './store';

const log = createLogger('backend/services/enduringAgents/memoryKernel');

const MemorySearchQuerySchema = z.object({
  query: z.string().trim().max(2_000).optional(),
  kinds: z.array(z.enum(MEMORY_KINDS)).optional(),
  scopes: z.array(z.enum(MEMORY_SCOPES)).optional(),
  statuses: z.array(z.enum(MEMORY_STATUSES)).optional(),
  trust: z.array(z.enum(MEMORY_TRUST_LEVELS)).optional(),
  coreOnly: z.boolean().optional(),
  mode: z.enum(['lexical', 'hybrid']).optional(),
  order: z.enum(['review']).optional(),
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
  /** Skip near-duplicate merge check (used by correctMemory which has explicit supersede semantics). */
  skipNearDuplicateMerge?: boolean;
}

export type MemoryRecallMode = 'lexical' | 'hybrid';

export interface MemorySearchQuery {
  query?: string;
  kinds?: MemoryKind[];
  scopes?: MemoryScope[];
  statuses?: MemoryStatus[];
  trust?: MemoryTrust[];
  coreOnly?: boolean;
  /** Internal comparison control. Omitted preserves workspace-configured behavior. */
  mode?: MemoryRecallMode;
  /** Specialized unreviewed-candidate ordering. Omitted preserves recall ordering. */
  order?: 'review';
  asOf?: number;
  limit?: number;
}

export interface MemoryConflictSummary {
  id: string;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  status: MemoryStatus;
  trust: MemoryTrust;
  confidence: number;
  importance: number;
  updatedAt: number;
}

export interface MemorySearchResult {
  item: MemoryItem;
  score: number;
  core: boolean;
  conflicts?: MemoryConflictSummary[];
}

export type ResolveMemoryConflictInput = z.infer<typeof ResolveMemoryConflictInputSchema>;

export interface ResolveMemoryConflictResult {
  resolutionId: string;
  audit: ConflictResolutionAudit;
  left: MemoryItem;
  right: MemoryItem;
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

/**
 * Storage adapter for the pure selector used by production and experiments.
 */
async function findNearDuplicateCandidate(
  personaId: string,
  kind: MemoryKind,
  scope: MemoryScope,
  content: string,
): Promise<{ candidate: MemoryItem; similarity: number } | null> {
  return selectNearDuplicateCandidate(
    await listMemoryItems(personaId),
    { kind, scope, content },
    MEMORY_DEDUP_SETTINGS,
  );
}

function requireOwnedMemory(item: MemoryItem | null, personaId: string, requestedId: string): MemoryItem {
  if (!item || item.personaId !== personaId) {
    throw new PersonaDomainNotFoundError('MemoryItem', requestedId);
  }
  return item;
}

export function assertActivationPolicy(
  trust: MemoryTrust,
  status: MemoryStatus,
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
  const settings = await getMemorySettings();
  const invokedByFlow = Boolean(options.executionAuthority);
  const trust: MemoryTrust = invokedByFlow ? 'model_inference' : input.trust;
  const status: 'candidate' | 'active' = invokedByFlow ? 'candidate' : input.status ?? 'candidate';
  const refs = [...input.sourceRefs];

  let expiresAt: number | undefined;
  if (status === 'candidate' && settings.candidateExpiryDays > 0) {
    expiresAt = now + (settings.candidateExpiryDays * 24 * 60 * 60 * 1000);
  }
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
    ...(input.conflictsWith?.length ? { conflictsWith: [...new Set(input.conflictsWith)].sort() } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    createdAt: now,
    updatedAt: now,
  }) as MemoryItem;

  const explicitIds = [...new Set(record.conflictsWith ?? [])].filter(id => id !== record.id).sort();
  const explicitTargets = explicitIds.length > 0
    ? await listMemoryItems(record.personaId, { ids: explicitIds })
    : [];
  if (
    explicitTargets.length !== explicitIds.length
    || explicitTargets.some(target => target.personaId !== record.personaId)
  ) {
    throw new PersonaDomainConflictError('conflictsWith must reference existing memories owned by this Persona.');
  }

  const automaticTargets = FEATURES.ENABLE_MEMORY_CONFLICT_SURFACING
    && settings.conflictDetectionEnabled
    ? await listMemoryItems(record.personaId, {
      statuses: ['active'],
      kinds: [record.kind],
      scopes: [record.scope],
      limit: 200,
      order: 'updated_at',
    })
    : [];
  const supersededIds = new Set(record.supersedes ?? []);
  const detectedTargets = automaticTargets.filter(target => (
    target.id !== record.id
    && !supersededIds.has(target.id)
    && lexicalRelationScorer.score(
      target.content,
      record.content,
      settings.conflictSimilarityThreshold,
    ).relation === 'contradict'
  ));
  const targetsById = new Map(
    [...explicitTargets, ...detectedTargets].map(target => [target.id, target]),
  );
  const conflictIds = [...targetsById.keys()].sort();
  const desiredRecord = conflictIds.length > 0
    ? { ...record, conflictsWith: conflictIds }
    : (() => {
      const { conflictsWith: _empty, ...withoutConflicts } = record;
      return withoutConflicts as MemoryItem;
    })();

  const existing = await getMemoryItem(record.personaId, record.id);
  if (existing) {
    const sameSemanticValue = existing.personaId === record.personaId
      && existing.kind === record.kind
      && existing.scope === record.scope
      && existing.status === record.status
      && existing.content === record.content
      && existing.confidence === record.confidence
      && existing.importance === record.importance
      && existing.trust === record.trust
      && stableSourceRefValue(existing) === stableSourceRefValue(record)
      && JSON.stringify(existing.supersedes ?? []) === JSON.stringify(record.supersedes ?? []);
    if (!sameSemanticValue) {
      throw new PersonaDomainConflictError(`MemoryItem ${JSON.stringify(record.id)} already exists.`);
    }
    if (conflictIds.length === 0) return existing;
  }

  // Relation classification precedes issue #450 dedup so a supported
  // contradiction can never be collapsed into its opposite.
  if (
    !existing
    && conflictIds.length === 0
    && MEMORY_DEDUP_SETTINGS.enabled
    && !options.skipNearDuplicateMerge
    && !record.supersedes?.length
  ) {
    const nearDup = await findNearDuplicateCandidate(record.personaId, record.kind, record.scope, record.content);
    if (nearDup) {
      const { candidate: survivor, similarity } = nearDup;
      const reinforced = await saveMemoryItem(buildReinforcedMemoryItem(survivor, {
        now,
        incomingTrust: record.trust,
        incomingSourceRefs: record.sourceRefs,
        canUpgradeTrust: (nextTrust) => {
          try {
            assertActivationPolicy(
              nextTrust,
              survivor.status,
              options,
              record.sourceRefs.map((ref) => ref.kind),
            );
            return true;
          } catch {
            return false;
          }
        },
      }));
      log.debug('Dedup merged near-duplicate', {
        survivorId: survivor.id,
        similarity: similarity.toFixed(3),
        kind: record.kind,
        scope: record.scope,
      });
      return reinforced;
    }
  }

  // The store has no durable multi-record transaction. Create the new record
  // without edges, then update targets, then complete its reverse edges. Every
  // step is idempotent and the lifecycle sweep repairs a crash after target writes.
  let saved = existing ?? await saveMemoryItem((() => {
    const { conflictsWith: _deferred, ...withoutConflicts } = desiredRecord;
    return withoutConflicts as MemoryItem;
  })());
  for (const target of targetsById.values()) {
    const links = [...new Set([...(target.conflictsWith ?? []), record.id])].sort();
    if (JSON.stringify(links) !== JSON.stringify(target.conflictsWith ?? [])) {
      await saveMemoryItem({
        ...target,
        conflictsWith: links,
        updatedAt: Math.max(Date.now(), target.updatedAt + 1),
      });
    }
  }
  if (conflictIds.length > 0) {
    const links = [...new Set([...(saved.conflictsWith ?? []), ...conflictIds])].sort();
    saved = await saveMemoryItem({
      ...saved,
      conflictsWith: links,
      updatedAt: Math.max(Date.now(), saved.updatedAt + 1),
    });
  }
  return saved;
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
  return requireOwnedMemory(await getMemoryItem(personaId, memoryId), personaId, memoryId);
}

function sameConflictPair(audit: ConflictResolutionAudit, leftId: string, rightId: string): boolean {
  return audit.memoryIds.includes(leftId) && audit.memoryIds.includes(rightId);
}

export async function resolveMemoryConflict(
  personaId: string,
  memoryId: string,
  input: ResolveMemoryConflictInput,
  options: MemoryMutationOptions = {},
): Promise<ResolveMemoryConflictResult> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(memoryId);
  const parsed = ResolveMemoryConflictInputSchema.parse(input);
  if (options.executionAuthority) {
    throw new PersonaDomainConflictError(
      'A model-run tool may only propose a conflict resolution for human review.',
    );
  }
  if (memoryId === parsed.counterpartId) {
    throw new PersonaDomainConflictError('A memory cannot resolve a conflict with itself.');
  }

  return withPersonaDomainMutation(personaId, options, async ({ persona, updatePersona }) => {
    const left = requireOwnedMemory(await getMemoryItem(personaId, memoryId), personaId, memoryId);
    const right = requireOwnedMemory(
      await getMemoryItem(personaId, parsed.counterpartId),
      personaId,
      parsed.counterpartId,
    );
    const resolutionId = parsed.resolutionId ?? randomEnduringAgentId('memresolution');
    const leftReplay = left.conflictResolutions?.find(audit => audit.resolutionId === resolutionId);
    const rightReplay = right.conflictResolutions?.find(audit => audit.resolutionId === resolutionId);
    const replayAudits = [leftReplay, rightReplay].filter(
      (audit): audit is ConflictResolutionAudit => audit !== undefined,
    );
    if (
      replayAudits.some(replay => (
        replay.action !== parsed.action
        || replay.reason !== parsed.reason
        || replay.memoryIds[0] !== left.id
        || replay.memoryIds[1] !== right.id
      ))
      || (leftReplay && rightReplay && JSON.stringify(leftReplay) !== JSON.stringify(rightReplay))
    ) {
      throw new PersonaDomainConflictError('Resolution ID was already used for a different decision.');
    }
    const replay = replayAudits[0];
    const histories = [...(left.conflictResolutions ?? []), ...(right.conflictResolutions ?? [])];
    const competing = histories.find(audit => (
      audit.resolutionId !== resolutionId
      && sameConflictPair(audit, left.id, right.id)
    ));
    if (competing) {
      throw new PersonaDomainConflictError('This memory conflict was already resolved.');
    }
    const linked = left.conflictsWith?.includes(right.id) || right.conflictsWith?.includes(left.id);
    if (!linked && !replay) {
      throw new PersonaDomainConflictError('The memories do not have an unresolved conflict relation.');
    }

    const updateCoreForWinner = async (resolvedLeft: MemoryItem, resolvedRight: MemoryItem) => {
      if (parsed.action === 'keep_both') return;
      const loserId = parsed.action === 'keep_left' ? right.id : left.id;
      const winner = parsed.action === 'keep_left' ? resolvedLeft : resolvedRight;
      const currentCore = persona.coreMemoryItemIds ?? [];
      const nextCore = [...new Set(currentCore.flatMap(id => (
        id !== loserId ? [id] : winner.status === 'active' ? [winner.id] : []
      )))];
      if (JSON.stringify(nextCore) !== JSON.stringify(currentCore)) {
        await updatePersona({
          ...persona,
          coreMemoryItemIds: nextCore,
          updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
        });
      }
    };
    if (leftReplay && rightReplay && !linked) {
      await updateCoreForWinner(left, right);
      return { resolutionId, audit: leftReplay, left, right };
    }

    const winnerId = parsed.action === 'keep_left'
      ? left.id
      : parsed.action === 'keep_right' ? right.id : undefined;
    const audit: ConflictResolutionAudit = replay ?? {
      resolutionId,
      memoryIds: [left.id, right.id],
      action: parsed.action,
      ...(winnerId ? { winnerId } : {}),
      actor: 'user',
      authority: 'manual_api',
      reason: parsed.reason,
      resolvedAt: Date.now(),
    };
    const appendAudit = (item: MemoryItem): ConflictResolutionAudit[] => {
      const history = item.conflictResolutions ?? [];
      return history.some(entry => entry.resolutionId === resolutionId)
        ? history
        : [...history, audit];
    };
    const withoutCounterpart = (item: MemoryItem, counterpartId: string): string[] | undefined => {
      const links = (item.conflictsWith ?? []).filter(id => id !== counterpartId);
      return links.length > 0 ? links : undefined;
    };
    const nextTimestamp = (item: MemoryItem) => Math.max(Date.now(), item.updatedAt + 1);

    let nextLeft: MemoryItem = {
      ...left,
      conflictsWith: withoutCounterpart(left, right.id),
      conflictResolutions: appendAudit(left),
      updatedAt: nextTimestamp(left),
    };
    let nextRight: MemoryItem = {
      ...right,
      conflictsWith: withoutCounterpart(right, left.id),
      conflictResolutions: appendAudit(right),
      updatedAt: nextTimestamp(right),
    };
    if (parsed.action === 'keep_left') {
      nextLeft = {
        ...nextLeft,
        supersedes: [...new Set([...(nextLeft.supersedes ?? []), right.id])].sort(),
      };
      nextRight = { ...nextRight, status: 'superseded' };
    } else if (parsed.action === 'keep_right') {
      nextRight = {
        ...nextRight,
        supersedes: [...new Set([...(nextRight.supersedes ?? []), left.id])].sort(),
      };
      nextLeft = { ...nextLeft, status: 'superseded' };
    }

    // Undefined optional fields must be omitted for strict persistence and clean API output.
    if (!nextLeft.conflictsWith) delete nextLeft.conflictsWith;
    if (!nextRight.conflictsWith) delete nextRight.conflictsWith;
    const savedLeft = await saveMemoryItem(nextLeft);
    const savedRight = await saveMemoryItem(nextRight);

    await updateCoreForWinner(savedLeft, savedRight);
    return { resolutionId, audit, left: savedLeft, right: savedRight };
  });
}

function queryTerms(query: string | undefined): string[] {
  return [...new Set((query?.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []))];
}

export interface SemanticRecallContext {
  readonly scores: ReadonlyMap<string, SemanticMemoryScore>;
  readonly floor: number;
  readonly lexicalWeight: number;
  readonly semanticWeight: number;
}

function lexicalRecallContext(
  floor: number = MEMORY_SEMANTIC_FLOOR,
): SemanticRecallContext {
  return {
    scores: new Map(),
    floor,
    lexicalWeight: 1,
    semanticWeight: 0,
  };
}

function semanticFallback(
  reason: string,
  floor: number = MEMORY_SEMANTIC_FLOOR,
): SemanticRecallContext {
  recordSemanticRecallFallback(reason);
  log.debug('Semantic recall unavailable; using lexical fallback.', { reason });
  return lexicalRecallContext(floor);
}

/**
 * Prepare one cached query embedding and one Persona sidecar read for a recall.
 * Provider and sidecar failures are intentionally contained at this boundary.
 */
export async function prepareSemanticRecall(
  personaId: string,
  query: string | undefined,
  items: readonly MemoryItem[],
): Promise<SemanticRecallContext> {
  if (!query?.trim()) return semanticFallback('empty_query');

  const settings = await getMemorySettings();
  if (!settings.semanticRecallEnabled) {
    return semanticFallback('disabled', settings.semanticFloor);
  }
  if (!settings.semanticEmbeddingModelId) {
    return semanticFallback('missing_model', settings.semanticFloor);
  }

  const model = await modelService.getModel(settings.semanticEmbeddingModelId);
  if (!model) return semanticFallback('model_not_found', settings.semanticFloor);
  if (!supportsEmbeddings(model.adapter)) {
    return semanticFallback('unsupported_adapter', settings.semanticFloor);
  }

  try {
    const embeddingStartedAt = performance.now();
    const queryVector = await getMemoryQueryVectorCache().getOrCreate({
      workspaceId: getCurrentWorkspace(),
      provider: model.adapter,
      modelId: model.name,
      dimensions: settings.semanticEmbeddingDimensions,
      query,
    }, async () => {
      const queryEmbedding = await getEmbeddingProvider().embed(model, {
        modelId: model.name,
        text: query,
        dimensions: settings.semanticEmbeddingDimensions,
      });
      if (
        queryEmbedding.vector.length === 0
        || queryEmbedding.vector.length !== queryEmbedding.dimensions
        || !queryEmbedding.vector.every(Number.isFinite)
      ) {
        throw new Error('Embedding provider returned an invalid query vector.');
      }
      return queryEmbedding.vector;
    });
    recordSemanticRecallStage(
      'query_embedding',
      performance.now() - embeddingStartedAt,
    );

    const sidecarStartedAt = performance.now();
    const embeddings = await listPersonaEmbeddings(personaId);
    recordSemanticRecallStage('sidecar_load', performance.now() - sidecarStartedAt);
    if (embeddings.length === 0) recordSemanticRecallFallback('missing_sidecar');

    const scoringStartedAt = performance.now();
    const scores = buildSemanticMemoryScores(
      personaId,
      items,
      embeddings,
      queryVector,
      model.name,
    );
    recordSemanticRecallStage('cosine_scoring', performance.now() - scoringStartedAt);

    return {
      scores,
      floor: settings.semanticFloor,
      lexicalWeight: settings.lexicalWeight,
      semanticWeight: settings.semanticWeight,
    };
  } catch {
    return semanticFallback('embedding_failure', settings.semanticFloor);
  }
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
  const reviewOrder = parsed.order === 'review';
  const defaultStatuses: MemoryStatus[] = ['active'];
  const limit = parsed.limit ?? (reviewOrder ? 20 : 50);
  const itemLoadStartedAt = performance.now();
  const items = await listMemoryItems(personaId, {
    statuses: reviewOrder ? ['candidate'] : parsed.statuses ?? defaultStatuses,
    kinds: parsed.kinds?.length ? parsed.kinds : undefined,
    scopes: parsed.scopes?.length ? parsed.scopes : undefined,
    trust: parsed.trust?.length ? parsed.trust : undefined,
    validAt: asOf,
    ids: parsed.coreOnly ? [...coreIds] : undefined,
    // Review order must inspect the complete eligible candidate set before
    // applying top-N. Recall can use the metadata index for term-free queries.
    ...(!reviewOrder && terms.length === 0 ? {
      limit,
      order: 'memory_relevance' as const,
      coreIds: [...coreIds],
    } : {}),
  });
  recordSemanticRecallStage('item_load', performance.now() - itemLoadStartedAt);
  const rankStartedAt = performance.now();
  let ordered: MemorySearchResult[];
  if (reviewOrder) {
    ordered = items
      .filter(item => (
        item.status === 'candidate'
        && item.reviewedAt === undefined
        && (item.expiresAt === undefined || item.expiresAt > asOf)
        && (terms.length === 0 || terms.some(
          term => item.content.toLocaleLowerCase().includes(term)
        ))
      ))
      .sort((left, right) => compareMemoryReviewCandidates(left, right, asOf))
      .slice(0, limit)
      .map(item => ({
        item,
        core: coreIds.has(item.id),
        score: memoryReviewScore(item, asOf),
      }));
  } else {
    const semantic = parsed.mode === 'lexical'
      ? lexicalRecallContext()
      : await prepareSemanticRecall(personaId, parsed.query, items);
    const candidates = items.map((item) => {
      const lexicalHit = terms.some(
        term => item.content.toLocaleLowerCase().includes(term),
      );
      return {
        item,
        core: coreIds.has(item.id),
        lexicalHit,
        semantic: semantic.scores.get(item.id),
      };
    });
    const eligible = candidates.filter(({ lexicalHit, semantic: semanticScore }) => (
      terms.length === 0
      || semanticCandidateEligible(lexicalHit, semanticScore, semantic.floor)
    ));
    recordSemanticRecallCandidates(candidates.length, eligible.length);
    const rankingWeights = {
      ...MEMORY_RANKING_WEIGHTS,
      lexicalWeight: semantic.lexicalWeight,
      semanticWeight: semantic.semanticWeight,
    };
    const results = eligible.map(({ item, core, semantic: semanticScore }) => ({
      item,
      core,
      score: scoreMemoryCandidate({
        item,
        terms,
        core,
        asOf,
        semantic: semanticScore,
        weights: rankingWeights,
      }),
    }));
    ordered = terms.length === 0 ? results : results.sort((left, right) => (
      right.score - left.score
      || right.item.updatedAt - left.item.updatedAt
      || left.item.id.localeCompare(right.item.id)
    )).slice(0, limit);
  }
  recordSemanticRecallStage('filter_rank', performance.now() - rankStartedAt);
  if (!FEATURES.ENABLE_MEMORY_CONFLICT_SURFACING) return ordered;

  const conflictIds = [...new Set(ordered.flatMap(
    result => result.item.conflictsWith ?? [],
  ))];
  if (conflictIds.length === 0) return ordered;
  const conflicts = await listMemoryItems(personaId, { ids: conflictIds });
  const conflictsById = new Map(conflicts.map(item => [item.id, item]));
  return ordered.map((result): MemorySearchResult => {
    const hydrated = (result.item.conflictsWith ?? [])
      .filter(id => id !== result.item.id)
      .map(id => conflictsById.get(id))
      .filter((item): item is MemoryItem => item?.personaId === personaId)
      .sort((left, right) => (
        Number(right.status === 'active') - Number(left.status === 'active')
        || right.updatedAt - left.updatedAt
        || left.id.localeCompare(right.id)
      ))
      .slice(0, 5)
      .map((item): MemoryConflictSummary => ({
        id: item.id,
        content: item.content,
        kind: item.kind,
        scope: item.scope,
        status: item.status,
        trust: item.trust,
        confidence: item.confidence,
        importance: item.importance,
        updatedAt: item.updatedAt,
      }));
    return hydrated.length > 0 ? { ...result, conflicts: hydrated } : result;
  });
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
    const original = requireOwnedMemory(await getMemoryItem(personaId, memoryId), personaId, memoryId);
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
    const item = requireOwnedMemory(await getMemoryItem(personaId, memoryId), personaId, memoryId);
    if (item.status === 'active') return item;
    if (item.status !== 'candidate') {
      throw new PersonaDomainConflictError('Only a candidate MemoryItem can be activated.');
    }
    assertActivationPolicy(item.trust, 'active', { ...options, reviewed: true }, item.sourceRefs.map((ref) => ref.kind));
    const now = Date.now();
    const activated = await saveMemoryItem({
      ...item,
      status: 'active',
      reviewedAt: now,
      updatedAt: Math.max(now, item.updatedAt + 1),
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
        const prior = await getMemoryItem(personaId, id);
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
    const item = requireOwnedMemory(await getMemoryItem(personaId, memoryId), personaId, memoryId);
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
    const item = requireOwnedMemory(await getMemoryItem(personaId, memoryId), personaId, memoryId);
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
    const byId = new Map((await listMemoryItems(personaId, { ids })).map((memory) => [memory.id, memory]));
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
    requireOwnedMemory(await getMemoryItem(personaId, memoryId), personaId, memoryId);
    const ids = (persona.coreMemoryItemIds ?? []).filter((id) => id !== memoryId);
    if (ids.length !== (persona.coreMemoryItemIds ?? []).length) {
      await updatePersona({
        ...persona,
        coreMemoryItemIds: ids,
        updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
      });
    }
    const byId = new Map((await listMemoryItems(personaId, { ids })).map((memory) => [memory.id, memory]));
    return ids.map((id) => byId.get(id)).filter((memory): memory is MemoryItem => Boolean(memory));
  });
}

export async function getCoreMemory(personaId: string): Promise<MemoryItem[]> {
  const persona = await getPersona(personaId);
  if (!persona) throw new PersonaDomainNotFoundError('Persona', personaId);
  const coreMemoryItemIds = persona.coreMemoryItemIds ?? [];
  if (coreMemoryItemIds.length === 0) return [];

  const byId = new Map((await listMemoryItems(personaId, { ids: coreMemoryItemIds })).map((memory) => [memory.id, memory]));
  return coreMemoryItemIds
    .map((id) => byId.get(id))
    .filter((item): item is MemoryItem => Boolean(item));
}
