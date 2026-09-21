import { PersonaRecoveryError } from './personaRecoveryError';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Flow } from '@/shared/types/flow';
import {
  EnduringAgentIdSchema, FlowSnapshotSchema, PersonaAttributionSchema, PersonaInstructionContextSchema,
} from '@/shared/types/enduringAgent';
import { assertValidWorkspaceName } from '@/utils/workspace';
import { PERSONA_SHARDED_COLLECTIONS } from '@/utils/storage/backend';
import { ENDURING_AGENT_COLLECTIONS as c } from './collections';
import { canonicalJson } from './behaviorRevisions';
import { validatePersonaRecoveryGraph, type PersonaRecoveryRecordInput } from './personaRecoveryGraph';
import { PERSONA_RECOVERY_RECORD_SPECS } from './personaRecoveryRecords';
import { PersonaRuntimeEventManifestSchema, PersonaRuntimeEventSchema } from './runtimeEvents';
import { PERSONA_RECOVERY_ORIGIN_PATH, PersonaRecoveryOriginsSchema, recoveryPersonaHash } from './personaRecoveryOrigins';
import {
  PERSONA_RECOVERY_ZIP_LIMITS, personaRecoveryFileByteLimit, validatePersonaRecoveryZipPath, type PersonaRecoveryZipFile,
} from './personaRecoveryZip';

export const PERSONA_RECOVERY_MANIFEST = 'persona-recovery-manifest.json';
export const PERSONA_RECOVERY_EXCLUSIONS = [
  'model-and-app-connection-configurations', 'account-login-and-authentication-caches',
  'external-files-and-browser-profiles', 'installed-executables-and-runtime-caches',
  'non-persona-conversations', 'cross-system-tickets-meetings-schedules-and-statistics',
] as const;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const sharded = new Set<string>(PERSONA_SHARDED_COLLECTIONS);
const countsSchema = z.record(z.string(), z.number().int().nonnegative());
const CountSchema = z.number().int().nonnegative();
const ModelArchiveSchema = z.object({
  version: z.literal(1),
  entry: z.object({
    archiveVersion: z.literal(1), id: EnduringAgentIdSchema, conversationId: EnduringAgentIdSchema,
    runId: z.string().optional(), node: z.object({ nodeId: z.string().min(1), nodeName: z.string().optional() }).strict(),
    modelId: z.string().min(1).max(256), modelName: z.string(), adapter: z.string().min(1), operation: z.string().min(1),
    timestamp: CountSchema, outcome: z.enum(['running', 'completed', 'error', 'cancelled']), attempt: z.number().int().positive(),
    inputMode: z.enum(['full-history', 'latest-message', 'isolated']).optional(),
    canonicalMessageCount: CountSchema, wireMessageCount: CountSchema, mediaCount: CountSchema,
  }).strict(),
  canonicalMessages: z.array(z.unknown()), genericWire: z.array(z.unknown()), sdkRequest: z.unknown(),
  media: z.array(z.object({
    id: z.string().min(1), parameterPath: z.string().min(1), kind: z.enum(['image', 'audio', 'video', 'file']),
    mimeType: z.string().min(1), byteLength: CountSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/),
    encoding: z.enum(['data-url', 'base64', 'file']), filename: z.string().optional(),
  }).strict()),
  provenance: z.array(z.unknown()).optional(), counts: countsSchema.optional(),
  visualCompaction: z.unknown().optional(), contextCompaction: z.unknown().optional(),
}).strict();
export const PersonaRecoveryManifestSchema = z.object({
  format: z.literal('flujo-persona-recovery'), version: z.literal(1), layoutVersion: z.literal(1),
  applicationVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  sourceWorkspace: z.string().refine((value) => { try { assertValidWorkspaceName(value); return true; } catch { return false; } }),
  captureId: z.uuid(), capturedAt: z.number().int().nonnegative(), generation: z.number().int().positive(),
  exclusions: z.array(z.enum(PERSONA_RECOVERY_EXCLUSIONS)),
  counts: countsSchema,
  requiredModelIds: z.array(z.string().min(1).max(256)), requiredAppNames: z.array(z.string().min(1).max(256)),
  files: z.array(z.object({
    path: z.string().min(1).max(1024), bytes: z.number().int().nonnegative().max(PERSONA_RECOVERY_ZIP_LIMITS.archiveBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().refine((file) => file.bytes <= personaRecoveryFileByteLimit(file.path), 'Recovery file exceeds its size limit.')).max(PERSONA_RECOVERY_ZIP_LIMITS.members - 1),
}).strict();
export type PersonaRecoveryManifest = z.infer<typeof PersonaRecoveryManifestSchema>;
type ObjectValue = Record<string, unknown>;

export function parsePersonaRecoveryJson(bytes: Buffer, label: string): ObjectValue {
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)); } catch { throw new PersonaRecoveryError(`Invalid UTF-8 JSON in Persona recovery ${label}.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PersonaRecoveryError(`Expected an object in Persona recovery ${label}.`);
  return value as ObjectValue;
}

function lines(bytes: Buffer, label: string): ObjectValue[] {
  const text = decoder.decode(bytes);
  if (text && !text.endsWith('\n')) throw new PersonaRecoveryError(`Incomplete recovery event log: ${label}`);
  return text.split('\n').filter(Boolean).map((line) => parsePersonaRecoveryJson(Buffer.from(line), label));
}

function id(value: unknown): string { return EnduringAgentIdSchema.parse(value); }
function jsonId(filename: string): string {
  if (!filename.endsWith('.json')) throw new PersonaRecoveryError('Unsupported recovery record filename.');
  return id(filename.slice(0, -5));
}

/** Validate captured inputs before producing a manifest, and again on restore. */
export function inspectPersonaRecoveryFiles(files: readonly PersonaRecoveryZipFile[], sourceWorkspace: string) {
  assertValidWorkspaceName(sourceWorkspace);
  const byPath = new Map<string, Buffer>();
  const reserved = new Set<string>();
  const parentPaths = new Set<string>();
  const records: PersonaRecoveryRecordInput[] = [];
  const flows = new Map<string, Flow>();
  const conversations = new Map<string, ObjectValue>();
  const counts: Record<string, number> = Object.fromEntries(Object.keys(PERSONA_RECOVERY_RECORD_SPECS).map((key) => [key, 0]));
  let totalBytes = 0;
  for (const file of files) {
    validatePersonaRecoveryZipPath(file.path);
    const key = file.path.toLowerCase();
    if (file.path === PERSONA_RECOVERY_MANIFEST || reserved.has(key) || parentPaths.has(key)) throw new PersonaRecoveryError('Duplicate recovery input path.');
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (reserved.has(parent)) throw new PersonaRecoveryError('Conflicting recovery file and directory paths.');
      parentPaths.add(parent);
    }
    reserved.add(key);
    totalBytes += file.bytes.length;
    if (file.bytes.length > personaRecoveryFileByteLimit(file.path) || totalBytes > PERSONA_RECOVERY_ZIP_LIMITS.totalBytes
      || reserved.size >= PERSONA_RECOVERY_ZIP_LIMITS.members) throw new PersonaRecoveryError('Recovery input exceeds archive limits.');
    byPath.set(file.path, file.bytes);
    const [kind, collection, ...tail] = file.path.split('/');
    if (kind === 'records') {
      if (!Object.prototype.hasOwnProperty.call(PERSONA_RECOVERY_RECORD_SPECS, collection)
        || tail.length < 1 || tail.length > 2 || (tail.length === 2 && !sharded.has(collection))) {
        throw new PersonaRecoveryError('Unsupported recovery collection layout.');
      }
      const value = parsePersonaRecoveryJson(file.bytes, file.path);
      if (tail.length === 2 && id(tail[0]) !== value.personaId) throw new PersonaRecoveryError('Recovery record is in another Persona shard.');
      records.push({ collection, storageId: jsonId(tail[tail.length - 1]), value });
      counts[collection]++;
    } else if (kind === 'flows') {
      if (tail.length) throw new PersonaRecoveryError('Invalid recovery Flow path.');
      const flow = FlowSnapshotSchema.parse(parsePersonaRecoveryJson(file.bytes, file.path));
      if (flow.id !== jsonId(collection)) throw new PersonaRecoveryError('Recovery Flow storage identity mismatch.');
      flows.set(flow.id, flow);
      counts.flows = (counts.flows ?? 0) + 1;
    } else if (kind === 'conversations') {
      if (tail.length) throw new PersonaRecoveryError('Invalid recovery conversation path.');
      const conversationId = jsonId(collection);
      const value = parsePersonaRecoveryJson(file.bytes, file.path);
      if ((value.conversationId !== undefined && value.conversationId !== conversationId)
        || !Array.isArray(value.messages) || typeof value.flowId !== 'string') throw new PersonaRecoveryError('Invalid recovery conversation snapshot.');
      if (value.executionAuthority !== undefined || value.personaCoreAppRefs !== undefined || value.ephemeral === true) {
        throw new PersonaRecoveryError('Recovery conversation contains runtime-only authority.');
      }
      conversations.set(conversationId, value);
      counts.conversations = (counts.conversations ?? 0) + 1;
    }
  }
  const graph = validatePersonaRecoveryGraph(records, sourceWorkspace);
  const activities = new Map(graph.records.filter((record) => record.collection === c.activities)
    .map((record) => [`${record.parsed.personaId}\0${record.id}`, record.parsed]));
  const originBytes = byPath.get(PERSONA_RECOVERY_ORIGIN_PATH);
  const origins = originBytes ? PersonaRecoveryOriginsSchema.parse(parsePersonaRecoveryJson(originBytes, PERSONA_RECOVERY_ORIGIN_PATH))
    : { id: 'origin' as const, version: 1 as const, tombstones: [] };
  const personas = new Set(graph.records.filter((record) => record.collection === c.personas).map((record) => record.id));
  for (const personaId of personas) {
    if (origins.tombstones.some((record) => record.personaIdHash === recoveryPersonaHash(record.workspaceId, personaId))) {
      throw new PersonaRecoveryError('A recovery deletion origin forbids restoring this live Persona.');
    }
  }
  const tombstones = new Set(graph.records.filter((record) => record.collection === c.deletionTombstones).map((record) => record.parsed.personaIdHash));
  const deletedOwner = (owner: string) => tombstones.has(recoveryPersonaHash(sourceWorkspace, owner))
    || origins.tombstones.some((record) => record.personaIdHash === recoveryPersonaHash(record.workspaceId, owner));
  const ownerExists = (owner: string) => personas.has(owner) || deletedOwner(owner);
  const requirePath = (name: string) => {
    const bytes = byPath.get(name);
    if (!bytes) throw new PersonaRecoveryError(`Recovery archive is missing ${name}.`);
    return bytes;
  };
  for (const flowId of graph.flowRefs) if (!flows.has(flowId)) throw new PersonaRecoveryError(`Recovery archive is missing Flow ${flowId}.`);
  for (const conversationId of graph.conversationRefs) requirePath(`conversations/${conversationId}.json`);
  const modelIds = new Set<string>();
  const appNames = new Set<string>();
  const conversationFamily = new Map<string, Set<string>>();
  const attributedConversations = new Set(graph.conversationRefs);
  const checkFlow = (input: unknown, checkDependencies: boolean) => {
    const flow = FlowSnapshotSchema.parse(input);
    const nodeIds = new Set(flow.nodes.map((node) => node.id));
    if (nodeIds.size !== flow.nodes.length) throw new PersonaRecoveryError('Recovery Flow has duplicate node identities.');
    if (flow.personaOwnership && !ownerExists(id(flow.personaOwnership.personaId))) throw new PersonaRecoveryError('Recovery Flow belongs to an unknown Persona.');
    for (const node of flow.nodes) {
      const props = node.data.properties ?? {};
      if (typeof props.boundModel === 'string' && props.boundModel) modelIds.add(props.boundModel);
      if (typeof props.model === 'string' && props.model) modelIds.add(props.model);
      if (typeof props.modelId === 'string' && props.modelId) modelIds.add(props.modelId);
      if (typeof props.boundServer === 'string' && props.boundServer) appNames.add(props.boundServer);
      if (checkDependencies) {
        const dependencies = [props.subflowId, ...(Array.isArray(props.parallelSubflowIds) ? props.parallelSubflowIds : [])];
        for (const ref of dependencies) if (typeof ref === 'string' && ref && !flows.has(ref)) throw new PersonaRecoveryError(`Recovery archive is missing callable Flow ${ref}.`);
      }
    }
    return flow;
  };
  for (const flow of flows.values()) checkFlow(flow, true);
  for (const record of graph.records) {
    const value = record.parsed;
    // Historical definitions are complete evidence even if a formerly callable
    // mutable Flow was later removed. Current authoring Flows are checked above.
    if (value.flowSnapshot) checkFlow(value.flowSnapshot, false);
    if (value.candidateFlow) checkFlow(value.candidateFlow, false);
    if (record.collection === c.roleVersions) {
      if (value.coreFlowTemplate) checkFlow(value.coreFlowTemplate, true);
      for (const slot of value.behaviorSlots as ObjectValue[]) checkFlow(slot.flowTemplate, true);
      if (typeof value.defaultModelId === 'string') modelIds.add(value.defaultModelId);
    }
    if (record.collection === c.appGrants) appNames.add(value.mcpServerName as string);
    if (record.collection === c.personas) {
      for (const app of (value.composition as ObjectValue | undefined)?.appRefs as string[] ?? []) appNames.add(app);
    }
  }
  for (const [conversationId, value] of conversations) {
    const attribution = value.personaAttribution ? PersonaAttributionSchema.parse(value.personaAttribution) : undefined;
    const owner = attribution?.personaId ?? value.personaTargetId;
    const attributedActivity = attribution?.activityId ? activities.get(`${owner}\0${attribution.activityId}`) : undefined;
    // A crash can leave the conversation projection at "running" after its
    // Activity and dispatch have durably failed. Preserve that evidence without
    // pretending it is live; the graph rejects active leases/running dispatches
    // and restore makes every old conversation read-only.
    if (value.status === 'running' && value.personaArchived !== true
      && (!attributedActivity || !['completed', 'error', 'cancelled'].includes(String(attributedActivity.status)))) {
      throw new PersonaRecoveryError('Persona conversation must finish or pause before recovery capture.');
    }
    if (owner !== undefined && !ownerExists(id(owner))) throw new PersonaRecoveryError('Recovery conversation belongs to an unknown Persona.');
    if (owner !== undefined || value.personaArchived === true) attributedConversations.add(conversationId);
    if (value.parentConversationId) requirePath(`conversations/${id(value.parentConversationId)}.json`);
    if (value.rootConversationId) requirePath(`conversations/${id(value.rootConversationId)}.json`);
    for (const parent of [value.parentConversationId, value.rootConversationId]) {
      if (parent === undefined || parent === null) continue;
      const parentId = id(parent);
      const from = conversationFamily.get(conversationId) ?? new Set<string>();
      from.add(parentId); conversationFamily.set(conversationId, from);
      const to = conversationFamily.get(parentId) ?? new Set<string>();
      to.add(conversationId); conversationFamily.set(parentId, to);
    }
    if (value.flowSnapshot) {
      const flow = checkFlow(value.flowSnapshot, false);
      if (flow.id !== value.flowId) throw new PersonaRecoveryError('Recovery conversation Flow snapshot identity mismatch.');
    } else if (!flows.has(value.flowId as string)) throw new PersonaRecoveryError('Recovery conversation is missing its Flow definition.');
    if (attribution?.activityId) {
      const activity = attributedActivity;
      if (!activity && !deletedOwner(owner as string)) throw new PersonaRecoveryError('Recovery conversation is missing its attributed Activity.');
      if (activity && !value.parentConversationId && activity.conversationId !== conversationId) throw new PersonaRecoveryError('Recovery conversation does not match its Activity.');
    }
    if (value.personaInstructionContext) {
      const context = PersonaInstructionContextSchema.parse(value.personaInstructionContext);
      if (context.personaId !== owner || context.activityId !== attribution?.activityId) throw new PersonaRecoveryError('Recovery conversation context ownership mismatch.');
      const activity = activities.get(`${owner}\0${context.activityId}`);
      if (activity && canonicalJson(context) !== canonicalJson(activity.instructionContext)) {
        throw new PersonaRecoveryError('Recovery conversation changed its frozen Activity instructions.');
      }
    }
  }
  const connected = [...attributedConversations];
  for (let index = 0; index < connected.length; index++) {
    for (const related of conversationFamily.get(connected[index]) ?? []) {
      if (!attributedConversations.has(related)) { attributedConversations.add(related); connected.push(related); }
    }
  }
  if ([...conversations.keys()].some((conversationId) => !attributedConversations.has(conversationId))) {
    throw new PersonaRecoveryError('Recovery includes an unrelated conversation.');
  }
  let expandedModelBytes = 0;
  for (const [name, bytes] of byPath) {
    if (name === PERSONA_RECOVERY_ORIGIN_PATH) continue;
    if (name === 'evidence/recovery-source.zip') {
      // Opaque prior recovery evidence. Never recursively inflate or install
      // any of its records as authority; it remains available for owner review.
      if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new PersonaRecoveryError('Invalid prior recovery archive evidence.');
      counts.recoverySourceArchives = 1;
      continue;
    }
    const [kind, first, second, third, ...rest] = name.split('/');
    if (kind === 'records' || kind === 'flows' || kind === 'conversations') continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (kind === 'flow-versions') {
      if (!second || third || !flows.has(id(first))) throw new PersonaRecoveryError('Invalid recovery Flow version path.');
      const value = parsePersonaRecoveryJson(bytes, name);
      if (value.versionId !== jsonId(second) || value.flowId !== first || !Number.isFinite(value.savedAt)
        || checkFlow(value.flow, false).id !== first) throw new PersonaRecoveryError('Recovery Flow version identity mismatch.');
    } else if (kind === 'conversation-logs' || kind === 'conversation-summaries') {
      const conversationId = kind === 'conversation-logs' && first.endsWith('.jsonl') ? id(first.slice(0, -6)) : jsonId(first);
      if (second || !conversations.has(conversationId)) throw new PersonaRecoveryError('Orphan recovery conversation artifact.');
      if (kind === 'conversation-summaries') {
        const summary = parsePersonaRecoveryJson(bytes, name);
        const conversation = conversations.get(conversationId)!;
        const attribution = conversation.personaAttribution as ObjectValue | undefined;
        if (summary.id !== conversationId || typeof summary.title !== 'string'
          || !Number.isFinite(summary.createdAt) || !Number.isFinite(summary.updatedAt)
          || !Number.isInteger(summary.version) || Number(summary.version) < 1 || Number(summary.version) > 9
          || (summary.personaId !== undefined && summary.personaId !== (attribution?.personaId ?? conversation.personaTargetId))) {
          throw new PersonaRecoveryError('Recovery conversation summary identity or version mismatch.');
        }
      } else {
        let seq = -1;
        for (const event of lines(bytes, name)) {
          if (event.conversationId !== undefined && event.conversationId !== conversationId) throw new PersonaRecoveryError('Recovery conversation log identity mismatch.');
          if (typeof event.type !== 'string' || (event.seq !== undefined && (!Number.isSafeInteger(event.seq) || Number(event.seq) < -1))) {
            throw new PersonaRecoveryError('Invalid recovery conversation log sequence.');
          }
          // The production transcript projector supports pre-#261 logs and
          // reads in file order. Keep their exact evidence, report anomalies,
          // and never use these old logs as resumable authority after restore.
          if (event.seq === undefined || Number(event.seq) <= seq) {
            counts.conversationLogSequenceAnomalies = (counts.conversationLogSequenceAnomalies ?? 0) + 1;
          }
          if (event.seq !== undefined) seq = Math.max(seq, Number(event.seq));
        }
      }
    } else if (kind === 'model-turns') {
      if (!conversations.has(id(first)) || !second || rest.length) throw new PersonaRecoveryError('Orphan recovery model-turn artifact.');
      if (second === 'media') {
        if (!third || !/^[a-f0-9]{64}$/.test(third) || digest(bytes) !== third) throw new PersonaRecoveryError('Recovery model media digest mismatch.');
        continue;
      }
      if (third || !second.endsWith('.json.gz')) throw new PersonaRecoveryError('Invalid recovery model-turn path.');
      const dispatchId = id(second.slice(0, -8));
      let expanded: Buffer;
      try { expanded = gunzipSync(bytes, { maxOutputLength: PERSONA_RECOVERY_ZIP_LIMITS.fileBytes }); }
      catch { throw new PersonaRecoveryError('Recovery model archive is invalid or exceeds its expanded byte limit.'); }
      expandedModelBytes += expanded.length;
      if (expandedModelBytes + totalBytes > PERSONA_RECOVERY_ZIP_LIMITS.totalBytes) throw new PersonaRecoveryError('Recovery model archives exceed expanded byte limits.');
      const value = ModelArchiveSchema.parse(parsePersonaRecoveryJson(expanded, name));
      const { entry } = value;
      if (entry.id !== dispatchId || entry.conversationId !== first || entry.mediaCount !== value.media.length
        || entry.canonicalMessageCount !== value.canonicalMessages.length || entry.wireMessageCount !== value.genericWire.length
        || new Set(value.media.map((media) => media.id)).size !== value.media.length) {
        throw new PersonaRecoveryError('Invalid recovery model-turn snapshot.');
      }
      modelIds.add(entry.modelId);
      for (const media of value.media) {
        if (requirePath(`model-turns/${first}/media/${media.sha256}`).length !== media.byteLength) throw new PersonaRecoveryError('Recovery media length mismatch.');
      }
    } else if (kind === 'home') {
      if (!personas.has(id(first)) || !second) throw new PersonaRecoveryError('Recovery home belongs to an unknown Persona.');
      if (bytes.subarray(0, 16).toString('binary') === 'SQLite format 3\0'
        || /(?:-wal|-shm|-journal)$/i.test(name)) throw new PersonaRecoveryError('Close and export Persona home databases before recovery capture.');
    } else if (kind === 'evidence' && first === 'runtime-events') {
      if (!personas.has(id(second)) || !third || rest.length) throw new PersonaRecoveryError('Invalid recovery runtime-event path.');
      if (third === 'manifest.json') {
        const manifest = PersonaRuntimeEventManifestSchema.parse(parsePersonaRecoveryJson(bytes, name));
        if (manifest.personaId !== second || manifest.workspaceId !== sourceWorkspace) throw new PersonaRecoveryError('Runtime-event manifest ownership mismatch.');
        const names = new Set(manifest.segments.map((segment) => segment.name));
        if (names.size !== manifest.segments.length || manifest.segments.at(-1)?.name !== manifest.activeSegment) {
          throw new PersonaRecoveryError('Invalid recovery runtime-event segment inventory.');
        }
        let previous = -1;
        for (const segment of manifest.segments) {
          const content = requirePath(`evidence/runtime-events/${second}/${segment.name}`);
          const events = lines(content, segment.name).map((line) => PersonaRuntimeEventSchema.parse(line));
          const active = segment.name === manifest.activeSegment;
          if (active ? segment.closedAt !== undefined : segment.closedAt === undefined) {
            throw new PersonaRecoveryError('Recovery runtime-event segment closure mismatch.');
          }
          // Active-segment metadata is persisted at rotation, not on every append.
          if ((active && (segment.bytes > content.length || segment.eventCount > events.length))
            || (!active && (segment.bytes !== content.length || segment.eventCount !== events.length
              || segment.lastSeq !== (events.at(-1)?.seq ?? -1)))
            || (events.length > 0 && segment.firstSeq !== events[0].seq)) {
            throw new PersonaRecoveryError('Recovery runtime-event segment metadata mismatch.');
          }
          for (const event of events) {
            if (event.seq <= previous) throw new PersonaRecoveryError('Recovery runtime-event segments overlap or are out of order.');
            previous = event.seq;
          }
        }
        const prefix = `evidence/runtime-events/${second}/`;
        for (const candidate of byPath.keys()) {
          if (candidate.startsWith(prefix) && candidate.endsWith('.jsonl') && candidate !== `${prefix}legacy.jsonl`
            && !names.has(candidate.slice(prefix.length))) throw new PersonaRecoveryError('Unindexed recovery runtime-event segment.');
        }
      } else if (third === 'legacy.jsonl' || /^segment-\d{6}\.jsonl$/.test(third)) {
        if (third !== 'legacy.jsonl') requirePath(`evidence/runtime-events/${second}/manifest.json`);
        let seq = -1;
        for (const line of lines(bytes, name)) {
          const event = PersonaRuntimeEventSchema.parse(line);
          if (event.personaId !== second || event.workspaceId !== sourceWorkspace || event.seq <= seq) throw new PersonaRecoveryError('Runtime-event ownership or ordering mismatch.');
          seq = event.seq;
        }
      } else throw new PersonaRecoveryError('Unsupported runtime-event recovery artifact.');
    } else throw new PersonaRecoveryError('Unsupported Persona recovery artifact.');
  }
  counts.deletionOrigins = origins.tombstones.length;
  return { graph, flows, conversations, origins, counts, requiredModelIds: [...modelIds].sort(), requiredAppNames: [...appNames].sort() };
}

export function createPersonaRecoveryManifest(
  files: readonly PersonaRecoveryZipFile[],
  capture: Pick<PersonaRecoveryManifest, 'sourceWorkspace' | 'applicationVersion' | 'captureId' | 'capturedAt' | 'generation'>,
): PersonaRecoveryManifest {
  const inspected = inspectPersonaRecoveryFiles(files, capture.sourceWorkspace);
  return PersonaRecoveryManifestSchema.parse({
    format: 'flujo-persona-recovery', version: 1, layoutVersion: 1, ...capture,
    exclusions: [...PERSONA_RECOVERY_EXCLUSIONS], counts: inspected.counts,
    requiredModelIds: inspected.requiredModelIds, requiredAppNames: inspected.requiredAppNames,
    files: files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}

export function validatePersonaRecoveryArchive(files: readonly PersonaRecoveryZipFile[]) {
  const manifests = files.filter((file) => file.path === PERSONA_RECOVERY_MANIFEST);
  if (manifests.length !== 1) throw new PersonaRecoveryError('Recovery archive must contain exactly one manifest.');
  const manifest = PersonaRecoveryManifestSchema.parse(parsePersonaRecoveryJson(manifests[0].bytes, PERSONA_RECOVERY_MANIFEST));
  const payload = files.filter((file) => file.path !== PERSONA_RECOVERY_MANIFEST);
  const expected = createPersonaRecoveryManifest(payload, manifest);
  if (canonicalJson(expected) !== canonicalJson(manifest)) throw new PersonaRecoveryError('Recovery manifest does not match its complete contents.');
  return { manifest, files: payload, ...inspectPersonaRecoveryFiles(payload, manifest.sourceWorkspace) };
}
