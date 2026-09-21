import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { archiveModelDispatch } from '@/backend/execution/flow/modelTurnArchive';
import { capturePersonaRecovery } from '@/backend/services/enduringAgents/personaRecoveryCapture';
import { PERSONA_RECOVERY_MANIFEST, inspectPersonaRecoveryFiles, validatePersonaRecoveryArchive } from '@/backend/services/enduringAgents/personaRecoveryArchive';
import { decodePersonaRecoveryZip } from '@/backend/services/enduringAgents/personaRecoveryZip';
import { ENDURING_AGENT_COLLECTIONS as c } from '@/backend/services/enduringAgents/collections';
import { claimNextPersonaActivity, completePersonaActivity, enqueuePersonaMailboxItem } from '@/backend/services/enduringAgents/activityRuntime';
import { getPersonaActivity, listMemoryItems, savePersonaActivity } from '@/backend/services/enduringAgents/store';
import { saveCollectionItem } from '@/utils/storage/backend';
import { getCurrentWorkspace, getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

jest.setTimeout(60_000);
let sequence = 0;
const fresh = <T>(task: () => Promise<T>) => runWithWorkspace(`persona-capture-${process.pid}-${++sequence}`, task);

async function fixture() {
  const { persona } = await createPersonaFromRole({
    id: 'persona_recovery_actor', name: 'Recovery actor', initialMemories: [{ content: 'Private recovery fact' }],
  });
  const root = getWorkspaceDataDir();
  const flowId = persona.composition!.coreFlowRef;
  await saveCollectionItem('conversations', 'conversation_recovery', {
    conversationId: 'conversation_recovery', flowId, personaTargetId: persona.id,
    status: 'completed', messages: [{ id: 'user_recovery', role: 'user', content: 'Private conversation', timestamp: 1 }],
  });
  await saveCollectionItem('conversations', 'conversation_unrelated', {
    conversationId: 'conversation_unrelated', flowId, status: 'completed', messages: [{ role: 'user', content: 'UNRELATED_CHAT_SENTINEL' }],
  });
  const home = path.join(root, 'userdata', 'personas', persona.id);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'notes.txt'), 'Private home file');
  await archiveModelDispatch({
    conversationId: 'conversation_recovery', nodeId: 'model_node', modelId: 'model-test', modelName: 'Test model',
    adapter: 'test', operation: 'create', attempt: 1, canonicalMessages: [], genericWire: [],
    sdkRequest: { image: `data:image/png;base64,${Buffer.from('model-image').toString('base64')}` },
  });
  return { persona, root, home, flowId };
}

describe('Persona recovery capture and complete manifest preflight', () => {
  it('captures actual Persona records and private artifacts, excluding unrelated chats and connection files', async () => fresh(async () => {
    const { persona } = await fixture();
    const sourceWorkspace = getCurrentWorkspace();
    await runWithWorkspace(`${sourceWorkspace}-other`, async () => {
      await createPersonaFromRole({ id: persona.id, name: 'OTHER_WORKSPACE_SENTINEL', initialMemories: [{ content: 'OTHER_WORKSPACE_PRIVATE' }] });
    });
    const captured = await capturePersonaRecovery();
    const files = decodePersonaRecoveryZip(captured.bytes);
    const recovered = validatePersonaRecoveryArchive(files);
    expect(recovered.manifest).toEqual(captured.manifest);
    expect(captured.manifest).toMatchObject({
      sourceWorkspace, counts: { [c.personas]: 1, [c.memoryItems]: 1, conversations: 1, home: 1 },
      requiredModelIds: expect.arrayContaining(['model-test']),
    });
    const content = Buffer.concat(files.map((file) => file.bytes)).toString('utf8');
    expect(content).toContain('Private recovery fact');
    expect(content).toContain('Private home file');
    expect(content).not.toContain('UNRELATED_CHAT_SENTINEL');
    expect(content).not.toContain('OTHER_WORKSPACE_');
    expect(files.some((file) => file.path.startsWith('model-turns/') && file.path.includes('/media/'))).toBe(true);
    expect(files.some((file) => /(?:models|mcp-config|encryption_key)\.json$/.test(file.path))).toBe(false);
    expect(recovered.graph.records.find((record) => record.id === persona.id)?.parsed.name).toBe(persona.name);
  }));

  it('fails capture during execution and succeeds after real lease release with runtime evidence', async () => fresh(async () => {
    const { persona } = await fixture();
    await enqueuePersonaMailboxItem({ personaId: persona.id, idempotencyKey: 'activity', kind: 'assignment', source: { kind: 'assignment', sourceId: 'activity' } });
    const claim = (await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 120_000 }))!;
    await expect(capturePersonaRecovery()).rejects.toThrow('active execution lease');
    await completePersonaActivity({
      workspaceId: getCurrentWorkspace(), personaId: persona.id, activityId: claim.activity.id,
      leaseId: claim.lease.id, holderId: claim.lease.holderId, fencingToken: claim.lease.fencingToken, status: 'completed',
    });
    const completed = (await getPersonaActivity(persona.id, claim.activity.id))!;
    await savePersonaActivity({ ...completed, conversationId: 'conversation_recovery', updatedAt: completed.updatedAt + 1 });
    await saveCollectionItem('conversations', 'conversation_recovery', {
      conversationId: 'conversation_recovery', flowId: persona.composition!.coreFlowRef,
      personaAttribution: { personaId: persona.id, activityId: claim.activity.id }, status: 'running', messages: [],
    });
    const files = decodePersonaRecoveryZip((await capturePersonaRecovery()).bytes);
    expect(validatePersonaRecoveryArchive(files).manifest.counts[c.activities]).toBe(1);
    expect(files.some((file) => file.path.startsWith(`evidence/runtime-events/${persona.id}/segment-`))).toBe(true);
    expect(JSON.parse(files.find((file) => file.path === 'conversations/conversation_recovery.json')!.bytes.toString()).status).toBe('running');
    const payload = files.filter((file) => file.path !== PERSONA_RECOVERY_MANIFEST);
    const segment = payload.find((file) => file.path.includes('/segment-'))!;
    expect(() => inspectPersonaRecoveryFiles([...payload, { ...segment, path: segment.path.replace(/segment-\d+/, 'segment-999999') }], getCurrentWorkspace()))
      .toThrow('Unindexed');
    expect(() => inspectPersonaRecoveryFiles(payload.filter((file) => !file.path.endsWith('/manifest.json')), getCurrentWorkspace()))
      .toThrow('missing evidence/runtime-events');
  }));

  it('rejects tampered bytes, missing dependencies/media and an unsupported manifest before restore', async () => fresh(async () => {
    const { persona, flowId } = await fixture();
    const files = decodePersonaRecoveryZip((await capturePersonaRecovery()).bytes);
    const tampered = files.map((file) => file.path === `home/${persona.id}/notes.txt` ? { ...file, bytes: Buffer.from('changed') } : file);
    expect(() => validatePersonaRecoveryArchive(tampered)).toThrow('manifest does not match');
    expect(() => validatePersonaRecoveryArchive(files.filter((file) => file.path !== `flows/${flowId}.json`))).toThrow('missing Flow');
    expect(() => validatePersonaRecoveryArchive(files.filter((file) => !file.path.includes('/media/')))).toThrow('missing model-turns');
    expect(() => validatePersonaRecoveryArchive(files.map((file) => file.path === PERSONA_RECOVERY_MANIFEST
      ? { ...file, bytes: Buffer.from(JSON.stringify({ ...JSON.parse(file.bytes.toString()), version: 2 })) } : file))).toThrow();
  }));

  it('deduplicates only byte-identical legacy/sharded records and rejects conflicting copies', async () => fresh(async () => {
    const { persona, root } = await fixture();
    const memory = (await listMemoryItems(persona.id))[0];
    const current = path.join(root, 'db', c.memoryItems, persona.id, `${memory.id}.json`);
    const legacy = path.join(root, 'db', c.memoryItems, `${memory.id}.json`);
    await fs.copyFile(current, legacy);
    const capture = await capturePersonaRecovery();
    expect(capture.manifest.counts[c.memoryItems]).toBe(1);
    await fs.writeFile(legacy, JSON.stringify({ ...memory, content: 'Conflicting fact' }));
    await expect(capturePersonaRecovery()).rejects.toThrow('Conflicting legacy');
  }));

  it('checks model archive outcome, counts, media descriptors and compression before trusting a new manifest', async () => fresh(async () => {
    await fixture();
    const payload = decodePersonaRecoveryZip((await capturePersonaRecovery()).bytes).filter((file) => file.path !== PERSONA_RECOVERY_MANIFEST);
    const model = payload.find((file) => file.path.endsWith('.json.gz'))!;
    const snapshot = JSON.parse(gunzipSync(model.bytes).toString());
    for (const entry of [{ ...snapshot.entry, outcome: 'invented' }, { ...snapshot.entry, mediaCount: 0 }]) {
      expect(() => inspectPersonaRecoveryFiles(payload.map((file) => file === model
        ? { ...file, bytes: gzipSync(JSON.stringify({ ...snapshot, entry })) } : file), getCurrentWorkspace())).toThrow();
    }
    expect(() => inspectPersonaRecoveryFiles(payload.map((file) => file === model
      ? { ...file, bytes: Buffer.from('invalid gzip') } : file), getCurrentWorkspace())).toThrow('model archive is invalid');
  }));

  it('byte-preserves supported historical log ordering and reports anomalies without accepting malformed sequences', async () => fresh(async () => {
    const { root } = await fixture();
    const bytes = Buffer.from([
      { type: 'message', seq: -1 }, { type: 'run:start', seq: 5 }, { type: 'message', seq: 1 }, { type: 'message' },
    ].map((event) => JSON.stringify({ ...event, conversationId: 'conversation_recovery' })).join('\n') + '\n');
    await fs.mkdir(path.join(root, 'db/conversation-logs'), { recursive: true });
    await fs.writeFile(path.join(root, 'db/conversation-logs/conversation_recovery.jsonl'), bytes);
    const capture = await capturePersonaRecovery();
    expect(capture.manifest.counts.conversationLogSequenceAnomalies).toBe(3);
    const files = decodePersonaRecoveryZip(capture.bytes);
    expect(files.find((file) => file.path === 'conversation-logs/conversation_recovery.jsonl')?.bytes).toEqual(bytes);
    expect(() => inspectPersonaRecoveryFiles(files.filter((file) => file.path !== PERSONA_RECOVERY_MANIFEST).map((file) => file.path.startsWith('conversation-logs/')
      ? { ...file, bytes: Buffer.from('{"type":"message","seq":"invalid"}\n') } : file), getCurrentWorkspace())).toThrow('Invalid recovery conversation log');
  }));

  it('rejects unsafe home files without producing a partial backup', async () => fresh(async () => {
    const { home } = await fixture();
    await fs.writeFile(path.join(home, 'state.db'), Buffer.from('SQLite format 3\0unfinished database'));
    await expect(capturePersonaRecovery()).rejects.toThrow('export Persona home databases');
    await fs.unlink(path.join(home, 'state.db'));
    await fs.link(path.join(home, 'notes.txt'), path.join(home, 'alias.txt'));
    await expect(capturePersonaRecovery()).rejects.toThrow('hard link');
  }));
});
