import { PersonaRecoveryError } from './personaRecoveryError';
import { randomUUID } from 'node:crypto';
import applicationPackage from '../../../../package.json';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { PERSONA_SHARDED_COLLECTIONS } from '@/utils/storage/backend';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceRecoveryCapture } from '@/backend/services/workspace/workspaceMutationGate';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { ENDURING_AGENT_COLLECTIONS as c } from './collections';
import { PERSONA_RECOVERY_RECORD_SPECS } from './personaRecoveryRecords';
import { validatePersonaRecoveryGraph } from './personaRecoveryGraph';
import { PersonaRecoveryFileReader } from './personaRecoveryFiles';
import {
  createPersonaRecoveryManifest, parsePersonaRecoveryJson, PERSONA_RECOVERY_MANIFEST,
} from './personaRecoveryArchive';
import { encodePersonaRecoveryZip, type PersonaRecoveryZipFile } from './personaRecoveryZip';
import { getPersonaFilesystemClock } from './runtimeClock';
import { PERSONA_RECOVERY_ORIGIN_PATH } from './personaRecoveryOrigins';

const sharded = new Set<string>(PERSONA_SHARDED_COLLECTIONS);
const id = (value: unknown) => EnduringAgentIdSchema.parse(value);

/**
 * Capture one selected workspace without invoking stores that migrate on read.
 * The HTTP boundary must separately enforce local, unlocked, non-worker access.
 * Compression happens after releasing registered workspace writers.
 */
export async function capturePersonaRecovery(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  if (isWorkerMode()) throw new PersonaRecoveryError('Persona recovery is unavailable on execution workers.');
  const sourceWorkspace = getCurrentWorkspace();
  const captured = await withWorkspaceRecoveryCapture(async (generation) => {
    const reader = new PersonaRecoveryFileReader(getWorkspaceDataDir(), options);
    const files = new Map<string, Buffer>();
    const add = (name: string, bytes: Buffer) => {
      const previous = files.get(name);
      if (previous && !previous.equals(bytes)) throw new PersonaRecoveryError(`Conflicting legacy and current Persona recovery records: ${name}`);
      files.set(name, bytes);
    };
    const records = [];
    const origins = await reader.read('db/persona-recovery/origin.json');
    if (origins) add(PERSONA_RECOVERY_ORIGIN_PATH, origins);
    const priorRecovery = await reader.read('db/persona-recovery/source.zip');
    if (priorRecovery) add('evidence/recovery-source.zip', priorRecovery);
    for (const collection of Object.keys(PERSONA_RECOVERY_RECORD_SPECS)) {
      for (const relative of await reader.scan(`db/${collection}`)) {
        const parts = relative.slice(`db/${collection}/`.length).split('/');
        if (parts.length > (sharded.has(collection) ? 2 : 1) || !parts.at(-1)!.endsWith('.json')) {
          throw new PersonaRecoveryError(`Unsupported Persona storage layout in ${collection}; finish recovery or migration before capture.`);
        }
        const bytes = (await reader.read(relative, true))!;
        const value = parsePersonaRecoveryJson(bytes, relative);
        const storageId = id(parts.at(-1)!.slice(0, -5));
        if (parts.length === 2 && id(parts[0]) !== value.personaId) throw new PersonaRecoveryError('Persona recovery found a foreign shard owner.');
        const name = sharded.has(collection)
          ? `records/${collection}/${id(value.personaId)}/${storageId}.json`
          : `records/${collection}/${storageId}.json`;
        if (!files.has(name)) records.push({ collection, storageId, value });
        // The storage migration deliberately permits identical flat/shard
        // duplicates. Preserve their exact common bytes once; conflicts fail.
        add(name, bytes);
      }
    }
    const graph = validatePersonaRecoveryGraph(records, sourceWorkspace);
    const personaIds = graph.records.filter((record) => record.collection === c.personas).map((record) => record.id);

    // All ordinary Flows in this workspace are included: dynamic callable Flow
    // selection cannot be represented by a static dependency-only traversal.
    for (const relative of await reader.scan('db/flows')) {
      if (!/^db\/flows\/[^/]+\.json$/.test(relative)) throw new PersonaRecoveryError('Unsupported Flow storage layout.');
      add(relative.slice(3), (await reader.read(relative, true))!);
    }
    const legacyFlows = await reader.read('db/flows.json');
    if (legacyFlows) {
      let values: unknown;
      try { values = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(legacyFlows)); } catch { throw new PersonaRecoveryError('Invalid legacy Flow storage.'); }
      if (!Array.isArray(values)) throw new PersonaRecoveryError('Invalid legacy Flow collection.');
      for (const value of values) {
        if (!value || typeof value !== 'object') throw new PersonaRecoveryError('Invalid legacy Flow definition.');
        const name = `flows/${id((value as { id: unknown }).id)}.json`;
        // Concurrent/unfinished legacy migrations must be completed first; a
        // byte-different current definition cannot be silently replaced.
        if (files.has(name)) throw new PersonaRecoveryError('Finish the legacy Flow storage migration before Persona recovery capture.');
        add(name, Buffer.from(JSON.stringify(value)));
      }
    }
    for (const name of [...files.keys()].filter((name) => name.startsWith('flows/'))) {
      const flowId = id(name.slice(6, -5));
      for (const relative of await reader.scan(`db/flow-versions/${flowId}`)) add(relative.slice(3), (await reader.read(relative, true))!);
    }

    const conversationInputs = new Map<string, { value: Record<string, unknown>; bytes: Buffer }>();
    const selected = new Set(graph.conversationRefs);
    for (const relative of await reader.scan('db/conversations')) {
      if (!/^db\/conversations\/[^/]+\.json$/.test(relative)) throw new PersonaRecoveryError('Unsupported conversation storage layout.');
      const conversationId = id(relative.slice('db/conversations/'.length, -5));
      const bytes = (await reader.read(relative, true))!;
      const value = parsePersonaRecoveryJson(bytes, relative);
      conversationInputs.set(conversationId, { value, bytes });
      if (value.personaAttribution || value.personaTargetId || value.personaInstructionContext || value.personaArchived === true) {
        selected.add(conversationId);
      }
    }
    // Include the full connected conversation family, preserving readable
    // parent/child evidence without importing unrelated standalone chats.
    const adjacent = new Map<string, Set<string>>();
    for (const [conversationId, { value }] of conversationInputs) {
      for (const parent of [value.parentConversationId, value.rootConversationId]) {
        if (parent === undefined || parent === null) continue;
        const parentId = id(parent);
        const from = adjacent.get(conversationId) ?? new Set<string>();
        from.add(parentId); adjacent.set(conversationId, from);
        const to = adjacent.get(parentId) ?? new Set<string>();
        to.add(conversationId); adjacent.set(parentId, to);
      }
    }
    const queue = [...selected];
    for (let index = 0; index < queue.length; index++) {
      for (const relative of adjacent.get(queue[index]) ?? []) {
        if (!selected.has(relative)) { selected.add(relative); queue.push(relative); }
      }
    }
    for (const conversationId of [...selected].sort()) {
      const input = conversationInputs.get(conversationId);
      if (!input) throw new PersonaRecoveryError(`Persona recovery is missing conversation ${conversationId}.`);
      add(`conversations/${conversationId}.json`, input.bytes);
      for (const [kind, extension] of [['conversation-logs', 'jsonl'], ['conversation-summaries', 'json']] as const) {
        const bytes = await reader.read(`db/${kind}/${conversationId}.${extension}`);
        if (bytes) add(`${kind}/${conversationId}.${extension}`, bytes);
      }
      for (const relative of await reader.scan(`db/model-turns/${conversationId}`)) add(relative.slice(3), (await reader.read(relative, true))!);
    }
    for (const personaId of personaIds) {
      for (const relative of await reader.scan(`userdata/personas/${personaId}`)) {
        add(relative.replace('userdata/personas/', 'home/'), (await reader.read(relative, true))!);
      }
      for (const relative of await reader.scan(`db/persona-runtime-events/${personaId}`)) {
        add(relative.replace('db/persona-runtime-events/', 'evidence/runtime-events/'), (await reader.read(relative, true))!);
      }
      const legacy = await reader.read(`db/persona-runtime-events/${personaId}.jsonl`);
      if (legacy) add(`evidence/runtime-events/${personaId}/legacy.jsonl`, legacy);
    }
    const payload: PersonaRecoveryZipFile[] = [...files].map(([name, bytes]) => ({ path: name, bytes }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const manifest = createPersonaRecoveryManifest(payload, {
      sourceWorkspace, applicationVersion: applicationPackage.version, captureId: randomUUID(), generation,
      capturedAt: getPersonaFilesystemClock().now(),
    });
    await reader.verifyUnchanged();
    return { manifest, files: [...payload, { path: PERSONA_RECOVERY_MANIFEST, bytes: Buffer.from(JSON.stringify(manifest)) }] };
  }, options);
  return { manifest: captured.manifest, bytes: await encodePersonaRecoveryZip(captured.files) };
}
