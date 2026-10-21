import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { configSchema, runtimeRevision, type ControllerConfig } from './config.js';
import { digest, Ledger, opaque } from './ledger.js';
import { LocalEngine } from './local-engine.js';
import { LocalRuntimeDriver, verifyLocalVolumes } from './local-runtime.js';
import { localRuntimePolicySchema, RuntimeControlError, type RuntimeIntent } from './local-runtime-policy.js';
import { ownerAuthority } from './authority-record.js';
import { publishPrivateFile } from './private-publish.js';
import { readPrivateFile } from './private-storage.js';
import { runRotationHelper } from './rotation-helper.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const planSchema = z.object({ operationId: z.string().regex(/^[a-f0-9]{32}$/), runtimeId: z.string(), actorId: z.string(),
  origin: z.string(), isolationId: z.string(), oldPolicy: localRuntimePolicySchema, newPolicy: localRuntimePolicySchema,
  previousDigest: hash, nextDigest: hash, previousRevision: hash, nextRevision: hash,
  issuedAt: z.number().int().nonnegative(), sourceDigest: hash, targetDigest: hash, candidateDigest: hash,
}).strict().refine(p => p.previousDigest !== p.nextDigest && p.newPolicy.credentialExpiresAt > p.issuedAt
  && JSON.stringify({ ...p.oldPolicy, credentialExpiresAt: p.newPolicy.credentialExpiresAt }) === JSON.stringify(p.newPolicy));
type Plan = z.infer<typeof planSchema>;
const phases = ['prepared', 'stopped', 'authority-updated', 'config-published', 'complete'] as const;
type Phase = typeof phases[number];
const canonical = (config: ControllerConfig) => digest(JSON.stringify(config));
const candidateFile = (config: ControllerConfig, plan: Plan) => join(config.stateDirectory, `rotation-${plan.operationId}.json`);
const readConfig = (filename: string) => {
  const contents = readPrivateFile(filename);
  return { contents, config: configSchema.parse(JSON.parse(contents.toString('utf8'))) };
};

function assertRegistered(ledger: Ledger, plan: Plan, complete = false): RuntimeIntent {
  const row = ledger.db.prepare('SELECT * FROM runtimes WHERE id=?').get(plan.runtimeId);
  const intent = ledger.intents().find(item => item.runtimeId === plan.runtimeId);
  if (!row || !intent || row.actor_id !== plan.actorId || row.origin !== plan.origin || row.isolation_id !== plan.isolationId
      || row.enabled !== 1 || row.revision !== (complete ? plan.nextRevision : plan.previousRevision)
      || intent.credentialDigest !== (complete ? plan.nextDigest : plan.previousDigest)
      || JSON.stringify(intent.policy) !== JSON.stringify(complete ? plan.newPolicy : plan.oldPolicy)) {
    throw new Error('Rotation no longer matches the registered owner.');
  }
  return intent;
}

function advance(ledger: Ledger, plan: Plan, phase: Phase): void {
  const stored = ledger.db.prepare('SELECT phase FROM runtime_rotations WHERE id=?').get(plan.operationId);
  if (!stored || !phases.includes(stored.phase as Phase)) throw new Error('Missing rotation journal.');
  if (phases.indexOf(stored.phase as Phase) < phases.indexOf(phase)) {
    ledger.db.prepare('UPDATE runtime_rotations SET phase=? WHERE id=?').run(phase, plan.operationId);
  }
}

function prepare(filename: string, config: ControllerConfig, ledger: Ledger, actorId: string): Plan {
  if (ledger.db.prepare("SELECT 1 FROM runtime_rotations WHERE phase!='complete'").get()) {
    throw new Error('Resume the pending rotation before rotating another owner.');
  }
  const runtime = config.runtimes.find(item => item.actorId === actorId);
  if (!runtime?.localRuntime || !config.localEngine) throw new Error('Rotation requires an enrolled local runtime.');
  const issuedAt = Date.now();
  const next = { ...runtime, credential: `flo_v1_${opaque()}`, localRuntime: { ...runtime.localRuntime,
    credentialExpiresAt: issuedAt + config.localEngine.credentialSeconds * 1000 } };
  const target = configSchema.parse({ ...config, runtimes: config.runtimes.map(item => item.id === runtime.id ? next : item) });
  const contents = JSON.stringify(target, null, 2) + '\n';
  const plan = planSchema.parse({ operationId: randomBytes(16).toString('hex'), runtimeId: runtime.id, actorId,
    origin: runtime.origin, isolationId: runtime.isolationId, oldPolicy: runtime.localRuntime, newPolicy: next.localRuntime,
    previousDigest: digest(runtime.credential), nextDigest: digest(next.credential), issuedAt,
    previousRevision: runtimeRevision(config, runtime), nextRevision: runtimeRevision(target, next),
    sourceDigest: canonical(config), targetDigest: canonical(target), candidateDigest: digest(contents) });
  assertRegistered(ledger, plan);
  // Only this private candidate contains plaintext. SQLite, helper stdin and
  // terminal output contain digests/metadata. Retain candidates for recovery.
  publishPrivateFile(candidateFile(config, plan), contents);
  ledger.transaction(() => {
    if (canonical(readConfig(filename).config) !== plan.sourceDigest) throw new Error('Configuration changed before rotation.');
    assertRegistered(ledger, plan);
    ledger.db.prepare('INSERT INTO runtime_rotations VALUES(?,?,?,?,?)')
      .run(plan.operationId, plan.runtimeId, JSON.stringify(plan), 'prepared', issuedAt);
    ledger.db.prepare('DELETE FROM sessions WHERE actor_id=?').run(actorId);
    ledger.db.prepare('UPDATE actors SET auth_revision=auth_revision+1 WHERE id=?').run(actorId);
    ledger.db.prepare(`UPDATE runtime_lifecycle SET desired='stopped',generation=generation+1,
      phase='pending',verified_at=NULL,problem=NULL WHERE runtime_id=?`).run(plan.runtimeId);
    ledger.audit('runtime.rotation.prepared', actorId, plan.runtimeId);
  });
  return plan;
}

function readCandidate(config: ControllerConfig, plan: Plan) {
  const candidate = readPrivateFile(candidateFile(config, plan));
  if (digest(candidate.toString('utf8')) !== plan.candidateDigest) throw new Error('Rotation candidate changed.');
  const target = configSchema.parse(JSON.parse(candidate.toString('utf8')));
  const next = target.runtimes.find(item => item.id === plan.runtimeId);
  if (canonical(target) !== plan.targetDigest || !next || runtimeRevision(target, next) !== plan.nextRevision
      || digest(next.credential) !== plan.nextDigest || JSON.stringify(next.localRuntime) !== JSON.stringify(plan.newPolicy)) {
    throw new Error('Rotation candidate does not match its journal.');
  }
  return { candidate, target };
}

async function finish(filename: string, config: ControllerConfig, ledger: Ledger, plan: Plan,
  engine: Pick<LocalEngine, 'run' | 'json'>): Promise<ControllerConfig> {
  const source = readConfig(filename);
  if (![plan.sourceDigest, plan.targetDigest].includes(canonical(source.config))) {
    throw new Error('Restore the source or target configuration before resuming rotation.');
  }
  const { candidate, target } = readCandidate(config, plan);
  const intent = assertRegistered(ledger, plan);
  if (intent.desired !== 'stopped') throw new Error('Rotation requires a durable stop intent.');
  const current = () => ledger.intentCurrent(intent);
  const driver = new LocalRuntimeDriver(engine);
  try {
    await driver.converge(intent, current);
    // A missing container can satisfy disable, but cannot authorize a rotation.
    if (await driver.inspect(intent) !== 'stopped' || !ledger.observeRuntime(intent)) throw new RuntimeControlError('state-unconfirmed');
    verifyLocalVolumes(await engine.json(intent.policy, ['volume', 'inspect', intent.policy.dataVolume,
      intent.policy.homeVolume, intent.policy.authorityVolume]), intent);
    if (!current()) throw new RuntimeControlError('superseded');
    advance(ledger, plan, 'stopped');
    await runRotationHelper(engine, intent, { operationId: plan.operationId, previousDigest: plan.previousDigest,
      previousExpiresAt: plan.oldPolicy.credentialExpiresAt,
      next: ownerAuthority(plan.actorId, plan.nextDigest, plan.issuedAt, plan.newPolicy.credentialExpiresAt) });
    if (await driver.inspect(intent) !== 'stopped' || !current()) throw new RuntimeControlError('state-unconfirmed');
    advance(ledger, plan, 'authority-updated');
    const latest = readConfig(filename);
    if (canonical(latest.config) === plan.sourceDigest) publishPrivateFile(filename, candidate, latest.contents);
    else if (canonical(latest.config) !== plan.targetDigest) throw new Error('Configuration changed during rotation.');
    advance(ledger, plan, 'config-published');
    ledger.transaction(() => {
      assertRegistered(ledger, plan);
      // Account disable is allowed while rotation holds the process lock. It
      // supersedes this observation and must be re-observed on the next retry.
      if (!current() || canonical(readConfig(filename).config) !== plan.targetDigest) throw new RuntimeControlError('superseded');
      const enabled = ledger.db.prepare('SELECT enabled FROM actors WHERE id=?').get(plan.actorId)?.enabled === 1;
      ledger.db.prepare('UPDATE runtimes SET revision=? WHERE id=?').run(plan.nextRevision, plan.runtimeId);
      ledger.db.prepare(`UPDATE runtime_lifecycle SET policy=?,credential_digest=?,generation=generation+1,
        desired=?,phase='pending',verified_at=NULL,problem=NULL WHERE runtime_id=?`)
        .run(JSON.stringify(plan.newPolicy), plan.nextDigest,
          enabled && plan.newPolicy.credentialExpiresAt > Date.now() ? 'running' : 'stopped', plan.runtimeId);
      ledger.db.prepare('DELETE FROM sessions WHERE actor_id=?').run(plan.actorId);
      ledger.db.prepare('UPDATE actors SET auth_revision=auth_revision+1 WHERE id=?').run(plan.actorId);
      advance(ledger, plan, 'complete');
      ledger.audit('runtime.rotation.complete', plan.actorId, plan.runtimeId);
    });
  } catch (error) {
    ledger.failRuntime(intent, error instanceof RuntimeControlError ? error.problem : 'state-unconfirmed');
    throw error;
  }
  return target;
}

/** Caller holds the same exclusive process lock as serve/provision. The journal
 * freezes admission until authority, private config and ledger agree. A retry
 * never invents another token or rebinds an owner's isolation identity. */
export async function rotateRuntime(filename: string, config: ControllerConfig, ledger: Ledger, actorId: string,
  resume = false, localEngine?: Pick<LocalEngine, 'run' | 'json'>) {
  if (canonical(readConfig(filename).config) !== canonical(config)) throw new Error('Configuration changed before rotation.');
  const runtime = config.runtimes.find(item => item.actorId === actorId);
  if (!runtime) throw new Error('Unknown configured owner.');
  const stored = ledger.db.prepare(`SELECT * FROM runtime_rotations WHERE runtime_id=?
    ${resume ? '' : "AND phase!='complete'"} ORDER BY rowid DESC LIMIT 1`).get(runtime.id);
  if (resume && !stored) throw new Error('No rotation to resume for this owner.');
  let plan = stored ? planSchema.parse(JSON.parse(String(stored.plan))) : prepare(filename, config, ledger, actorId);
  if (plan.actorId !== actorId || plan.runtimeId !== runtime.id || (stored && stored.id !== plan.operationId)) throw new Error('Rotation identity changed.');
  const engine = localEngine ?? new LocalEngine(config.stateDirectory);
  if (stored?.phase !== 'complete') config = await finish(filename, config, ledger, plan, engine);
  else if (canonical(config) !== plan.targetDigest) {
    // Windows cannot fsync directories through Node. If a rename was lost but
    // SQLite committed, recover only the exact journaled source and candidate.
    assertRegistered(ledger, plan, true);
    const source = readConfig(filename);
    if (canonical(source.config) !== plan.sourceDigest) throw new Error('Completed rotation no longer matches this configuration.');
    const { candidate, target } = readCandidate(config, plan);
    publishPrivateFile(filename, candidate, source.contents); config = target;
  }
  assertRegistered(ledger, plan, true);
  // Recovery of an expired interrupted candidate first commits it stopped, then
  // performs one fresh rotation. No expired credential authorizes a start.
  if (plan.newPolicy.credentialExpiresAt <= Date.now()) {
    plan = prepare(filename, config, ledger, actorId);
    config = await finish(filename, config, ledger, plan, engine);
  }
  const intent = assertRegistered(ledger, plan, true);
  try {
    if (intent.policy.credentialExpiresAt <= Date.now()) throw new RuntimeControlError('credential-expired');
    await new LocalRuntimeDriver(engine).converge(intent, () => ledger.intentCurrent(intent));
    if (!ledger.observeRuntime(intent)) throw new RuntimeControlError('superseded');
  } catch (error) { ledger.failRuntime(intent, error instanceof RuntimeControlError ? error.problem : 'state-unconfirmed'); }
  const latest = ledger.intents().find(item => item.runtimeId === plan.runtimeId)!;
  return { operationId: plan.operationId, runtimeId: plan.runtimeId, actorId, phase: 'complete',
    expiresAt: plan.newPolicy.credentialExpiresAt, desired: latest.desired,
    verified: latest.generation === intent.generation && latest.phase === 'confirmed', problem: latest.problem };
}
