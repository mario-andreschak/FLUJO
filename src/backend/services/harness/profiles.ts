import { flowService } from '@/backend/services/flow';
import { withWorkspaceRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { activateBehaviorBindingRevision, createBehaviorRevision, getBehaviorBinding, listBehaviorRevisions } from '@/backend/services/enduringAgents/store';
import { BehaviorRevisionSchema, BEHAVIOR_REVISION_SCHEMA_VERSION } from '@/shared/types/enduringAgent';
import { behaviorRevisionId, hashBehaviorFlow } from '@/backend/services/enduringAgents/behaviorRevisions';
import { listCollectionItems, loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { HarnessTargetSchema, HarnessPolicySchema, type HarnessProfile, type HarnessTarget, type HarnessVersion } from '@/shared/types/harnessIntegration';
import type { HarnessRun } from '@/shared/types/harness';
import { captureHarnessTarget, harnessCandidateFlow, harnessTargetId, harnessTargetPrompt, assertHarnessTargetCurrent, snapshotHarnessFlow } from './targets';
import { harnessDigest } from './executionScope';
import { assertHarnessEnabled } from './service';
import { getHarnessModel } from './model';
import { HarnessError } from './service';
import type { Flow } from '@/shared/types/flow';

const COLLECTION = 'harness-profiles';
const VERSIONS = 'harness-versions';
type TargetOwner = { kind: 'flow'; flowId: string } | { kind: 'persona'; personaId: string; behaviorId: string };
const ownerKey = (target: TargetOwner) => harnessDigest(target.kind === 'flow'
  ? { kind: target.kind, flowId: target.flowId } : { kind: target.kind, personaId: target.personaId, behaviorId: target.behaviorId });
export const listHarnessProfiles = () => listCollectionItems<HarnessProfile>(COLLECTION);
export const getHarnessProfile = (id: string) => loadCollectionItem<HarnessProfile | null>(COLLECTION, id, null);
export async function harnessProfilesForTarget(target: TargetOwner) {
  const ids = await loadCollectionItem<string[]>('harness-target-index', ownerKey(target), []);
  const profiles = await Promise.all(ids.map(getHarnessProfile));
  return profiles.filter((profile): profile is HarnessProfile => Boolean(profile && ownerKey(profile.target) === ownerKey(target)));
}
export async function readHarnessVersionFlow(profileId: string, version: HarnessVersion): Promise<Flow> {
  const flow = version.flow ?? await loadCollectionItem<Flow | null>(VERSIONS, harnessDigest([profileId, version.id]), null);
  if (!flow || hashBehaviorFlow(flow) !== version.flowHash) throw new HarnessError('The immutable version snapshot is unavailable or changed.', 409);
  return structuredClone(flow);
}
export async function saveHarnessProfile(profile: HarnessProfile) {
  const key = ownerKey(profile.target);
  await withWorkspaceRuntimeLock(harnessDigest({ lock: 'target-index', id: key }), async () => {
    const ids = await loadCollectionItem<string[]>('harness-target-index', key, []);
    if (!ids.includes(profile.id)) await saveCollectionItem('harness-target-index', key, [...ids, profile.id]);
  });
  for (const version of profile.versions) {
    if (!version.flow) continue;
    const id = harnessDigest([profile.id, version.id]);
    const existing = await loadCollectionItem<Flow | null>(VERSIONS, id, null);
    if (existing && hashBehaviorFlow(existing) !== version.flowHash) throw new HarnessError('Version identity already belongs to different content.', 409);
    if (!existing) await saveCollectionItem(VERSIONS, id, version.flow);
    delete version.flow;
  }
  profile.updatedAt = Math.max(Date.now(), profile.updatedAt + 1);
  // Version snapshots are never pruned as part of routine flow history.
  profile.events = profile.events.slice(-200);
  await saveCollectionItem(COLLECTION, profile.id, profile);
}
function event(profile: HarnessProfile, action: string, detail: string, versionId?: string, experimentId?: string) {
  profile.events.push({ at: Date.now(), action, detail, versionId, experimentId });
}

export async function configureHarnessProfile(rawTarget: unknown, rawPolicy: unknown, expectedUpdatedAt?: number) {
  await assertHarnessEnabled();
  const target = HarnessTargetSchema.parse(rawTarget), policy = HarnessPolicySchema.parse(rawPolicy);
  const id = harnessTargetId(target);
  return withWorkspaceRuntimeLock(harnessDigest({ lock: 'target-config', id: ownerKey(target) }), () =>
    withWorkspaceRuntimeLock(harnessDigest({ lock: 'profile', id }), async () => {
    let profile = await getHarnessProfile(id);
    if (profile && profile.updatedAt !== expectedUpdatedAt) throw new HarnessError('Improvement settings changed. Refresh before saving.');
    if (profile?.policy.automatic && !policy.automatic) {
      profile.policy = policy;
      event(profile, 'automatic_disabled', 'Unattended improvement disabled.');
      await saveHarnessProfile(profile);
      return profile;
    }
    if (profile?.pendingActivation) throw new HarnessError('Retry the pending version activation before changing these settings.', 409);
    if (policy.automatic && (await harnessProfilesForTarget(target)).some(item => item.id !== id && item.policy.automatic)) {
      throw new HarnessError('Another step in this agent or behavior is already improving automatically. Disable it before enabling this step.', 409);
    }
    await getHarnessModel(policy.modelId);
    const runtime = await captureHarnessTarget(target, policy.maxModelCallsPerProbe);
    const versionId = harnessDigest({ target, revision: runtime.baseRevision });
    const baseline: HarnessVersion = { id: versionId, createdAt: Date.now(), label: 'Captured baseline',
      prompt: harnessTargetPrompt(runtime.flow, target.nodeId), flow: runtime.flow, flowHash: hashBehaviorFlow(runtime.flow),
      ...(target.kind === 'persona' ? { behaviorRevisionId: runtime.baseRevision } : {}) };
    if (!profile) profile = { id, target, policy, updatedAt: 0, versions: [baseline], activeVersionId: versionId, events: [] };
    else {
      const active = profile.versions.find(version => version.id === profile!.activeVersionId);
      const matches = target.kind === 'persona' ? active?.behaviorRevisionId === runtime.baseRevision
        : active?.flowHash === runtime.baseRevision;
      if (!matches) {
        if (!profile.versions.some(version => version.id === versionId)) profile.versions.push(baseline);
        profile.activeVersionId = versionId;
        event(profile, 'baseline_captured', 'Captured the externally edited source as a new baseline.', versionId);
      }
      profile.policy = policy;
    }
    event(profile, policy.automatic ? 'automatic_enabled' : 'automatic_disabled', policy.automatic
      ? 'Unattended proposal, real-engine evaluation and validated activation enabled.' : 'Unattended improvement disabled.');
    profile.lastError = undefined;
    await saveHarnessProfile(profile);
    return profile;
  }));
}

/** Profile lock + source CAS: changing a saved flow never interrupts an already pinned run. */
async function activateWithinLock(profile: HarnessProfile, version: HarnessVersion, actor: string) {
  await assertHarnessEnabled();
  if (profile.pendingActivation && profile.pendingActivation.versionId !== version.id) {
    throw new HarnessError('Finish or retry the pending activation before selecting another version.', 409);
  }
  const runtime = await captureHarnessTarget(profile.target, profile.policy.maxModelCallsPerProbe, 'source');
  const active = profile.versions.find(item => item.id === profile.activeVersionId)!;
  const expectedRevision = profile.pendingActivation?.expectedRevision ?? (profile.target.kind === 'persona'
    ? active.behaviorRevisionId! : active.flowHash);
  const wanted = profile.target.kind === 'persona' ? version.behaviorRevisionId! : version.flowHash;
  if (runtime.baseRevision !== expectedRevision && runtime.baseRevision !== wanted) throw new HarnessError('The source was edited or activated elsewhere. Refresh and capture its new baseline first.');
  profile.pendingActivation = { versionId: version.id, expectedRevision, actor };
  await saveHarnessProfile(profile);
  if (runtime.baseRevision !== wanted) {
    if (profile.target.kind === 'persona') {
      await activateBehaviorBindingRevision({ personaId: profile.target.personaId, behaviorId: profile.target.behaviorId,
        revisionId: wanted, expectedActiveRevisionId: expectedRevision });
    } else {
      const current = (await flowService.readFlowExecutionSnapshot(profile.target.flowId))?.flow;
      if (!current || hashBehaviorFlow(await snapshotHarnessFlow(current)) !== expectedRevision) throw new HarnessError('The source agent changed before activation.');
      const saved = await flowService.saveFlow({ ...await readHarnessVersionFlow(profile.id, version), id: current.id, folder: current.folder,
        favorite: current.favorite, createdAt: current.createdAt }, { expectedUpdatedAt: current.updatedAt });
      if (!saved.success) throw new HarnessError('The agent could not be activated. Its pending activation can be retried.');
    }
  }
  profile.activeVersionId = version.id;
  version.activatedAt ??= Date.now();
  profile.pendingActivation = undefined;
  profile.lastError = undefined;
  event(profile, actor === 'automatic' ? 'auto_activated' : 'activated', `Activated by ${actor}. In-flight executions keep their original snapshots.`, version.id, version.experimentId);
  await saveHarnessProfile(profile);
  return profile;
}

export async function activateHarnessVersion(id: string, versionId: string, expectedUpdatedAt: number) {
  return withWorkspaceRuntimeLock(harnessDigest({ lock: 'profile', id: id }), async () => {
    const profile = await getHarnessProfile(id);
    if (!profile || profile.updatedAt !== expectedUpdatedAt) throw new HarnessError('Version state changed. Refresh before activation.');
    const version = profile.versions.find(item => item.id === versionId);
    if (!version) throw new HarnessError('The requested version does not belong to this target.');
    // Manual navigation has lasting authority over a pending automatic generation.
    profile.policy.automatic = false;
    return activateWithinLock(profile, version, 'user or agent tool');
  });
}

export async function publishHarnessVersion(run: HarnessRun, automatic = false) {
  if (!run.runtime || !run.profileId || run.status !== 'completed' || !run.decision?.eligible) throw new HarnessError('This experiment has no validated target revision.');
  return withWorkspaceRuntimeLock(harnessDigest({ lock: 'profile', id: run.profileId }), async () => {
    const profile = await getHarnessProfile(run.profileId!);
    if (!profile || (automatic && (!profile.policy.automatic || harnessDigest(profile.policy) !== run.runtime?.policyHash))) throw new HarnessError('Unattended settings changed or activation was disabled.', 409);
    let version = profile.versions.find(item => item.experimentId === run.id);
    // A response retry must not undo a later manual rollback or activate an old experiment twice.
    if (version?.activatedAt) return profile;
    if (!automatic) profile.policy.automatic = false;
    if (!version) {
      await assertHarnessTargetCurrent(run.runtime!);
      const selected = run.candidates.find(item => item.id === run.selectedId)!;
      const flow = harnessCandidateFlow(run.runtime!, selected.prompt);
      version = { id: harnessDigest({ profile: profile.id, experiment: run.id, prompt: selected.promptHash }),
        createdAt: Date.now(), parentId: profile.activeVersionId, experimentId: run.id, label: run.input.name,
        prompt: selected.prompt, flow, flowHash: hashBehaviorFlow(flow) };
      if (profile.target.kind === 'persona') {
        const binding = await getBehaviorBinding(profile.target.behaviorId);
        if (!binding || binding.activeRevisionId !== run.runtime!.baseRevision) throw new HarnessError('Persona behavior changed before publication.');
        const prior = await listBehaviorRevisions(profile.target.personaId);
        const recovered = prior.find(item => item.behaviorId === binding.id && item.source.kind === 'persona_override'
          && item.source.evidenceRefs?.includes(`harness:${run.id}`));
        const ordinal = Math.max(0, ...prior.filter(item => item.behaviorId === binding.id).map(item => item.revision)) + 1;
        const contentHash = hashBehaviorFlow(flow);
        if (recovered && recovered.contentHash !== contentHash) throw new HarnessError('Published experiment content changed.', 409);
        const revision = recovered ?? await createBehaviorRevision(BehaviorRevisionSchema.parse({
          schemaVersion: BEHAVIOR_REVISION_SCHEMA_VERSION,
          id: behaviorRevisionId({ personaId: binding.personaId, behaviorId: binding.id, revision: ordinal, contentHash }),
          personaId: binding.personaId, behaviorId: binding.id, slotKey: binding.slotKey, revision: ordinal, contentHash,
          flowSnapshot: flow, createdAt: Date.now(), source: { kind: 'persona_override', parentRevisionId: binding.activeRevisionId,
            evidenceRefs: [`harness:${run.id}`], authoredFlowProvenance: run.runtime!.authoredFlow },
        }));
        version.behaviorRevisionId = revision.id;
      }
      profile.versions.push(version);
      event(profile, 'validated', 'Candidate passed paired training and held-out evaluation through the flow engine.', version.id, run.id);
      await saveHarnessProfile(profile);
    }
    const source = await captureHarnessTarget(profile.target, profile.policy.maxModelCallsPerProbe, 'source');
    const wanted = profile.target.kind === 'persona' ? version.behaviorRevisionId : version.flowHash;
    if (source.baseRevision !== wanted) {
      await assertHarnessTargetCurrent(run.runtime!);
      for (const variant of Object.values(run.runtimeVariants ?? {})) await assertHarnessTargetCurrent(variant);
    }
    return activateWithinLock(profile, version, automatic ? 'automatic' : 'reviewed experiment');
  });
}

/** Called after the existing Persona administration path releases its Persona lock. */
export async function noteHarnessPersonaSelection(personaId: string, behaviorId: string, revisionId: string) {
  for (const item of await harnessProfilesForTarget({ kind: 'persona', personaId, behaviorId })) {
    if (item.target.kind !== 'persona' || item.target.personaId !== personaId || item.target.behaviorId !== behaviorId) continue;
    await withWorkspaceRuntimeLock(harnessDigest({ lock: 'profile', id: item.id }), async () => {
      const profile = await getHarnessProfile(item.id);
      if (!profile) return;
      profile.policy.automatic = false;
      profile.pendingActivation = undefined;
      const selected = profile.versions.find(version => version.behaviorRevisionId === revisionId);
      if (selected) profile.activeVersionId = selected.id;
      else profile.lastError = 'A different Persona revision was selected. Capture it as the baseline before resuming improvement.';
      event(profile, 'persona_selection', 'Persona version selection paused automatic improvement.', selected?.id);
      await saveHarnessProfile(profile);
    });
  }
}

/** Preserve explicit forward/backward selection until the authored source changes. */
export async function isHarnessBehaviorSelection(personaId: string, behaviorId: string, revisionId: string, authoredFlowRef: string, authoredHash: string) {
  const profiles = await harnessProfilesForTarget({ kind: 'persona', personaId, behaviorId });
  for (const profile of profiles) {
    if (profile.target.kind !== 'persona' || profile.target.personaId !== personaId || profile.target.behaviorId !== behaviorId) continue;
    const selected = profile.versions.find(item => (item.id === profile.activeVersionId || item.id === profile.pendingActivation?.versionId)
      && item.behaviorRevisionId === revisionId);
    if (selected?.behaviorRevisionId !== revisionId) continue;
    const revisions = await listBehaviorRevisions(personaId);
    const evidence = revisions.find(item => item.id === revisionId)?.source;
    if (evidence?.kind === 'persona_override' && evidence.authoredFlowProvenance?.flowRef === authoredFlowRef
      && evidence.authoredFlowProvenance.contentHash === authoredHash) return true;
    // Baseline rollback is pinned by a validated descendant's authoring anchor.
    if (revisions.some(item => item.source.kind === 'persona_override' && item.source.parentRevisionId === revisionId
      && item.source.evidenceRefs?.some(ref => ref.startsWith('harness:'))
      && item.source.authoredFlowProvenance?.flowRef === authoredFlowRef
      && item.source.authoredFlowProvenance.contentHash === authoredHash)) return true;
  }
  return false;
}
