import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { configSchema, runtimeRevision, type ControllerConfig, type Runtime } from './config.js';
import { digest, Ledger } from './ledger.js';
import { LocalEngine } from './local-engine.js';
import { localRuntimePolicySchema, type LocalRuntimePolicy, type RuntimeIntent } from './local-runtime-policy.js';
import { verifyLocalRuntime } from './local-runtime.js';
import { assertPrivateDirectory, readPrivateFile } from './private-storage.js';

const planSchema = z.object({ policy: localRuntimePolicySchema, issuedAt: z.number().int().nonnegative() }).strict();
const fixedEnvironment = (runtime: Runtime): string[] => [
  'NODE_ENV=production', 'FLUJO_CONTAINER=1', 'FLUJO_DATA_DIR=/app/data', 'HOME=/owner-home',
  'FLUJO_OWNER_AUTH_FILE=/run/flujo-owner/owner.json', `FLUJO_OWNER_BROWSER_ORIGIN=${runtime.origin}`, 'FLUJO_EXPOSURE_MODE=public',
];
const volumeMounts = (policy: LocalRuntimePolicy, readonly: boolean): string[] => [
  '--mount', `type=volume,source=${policy.dataVolume},target=/app/data`,
  '--mount', `type=volume,source=${policy.homeVolume},target=/owner-home`,
  '--mount', `type=volume,source=${policy.authorityVolume},target=/run/flujo-owner${readonly ? ',readonly' : ''}`,
];

export function runtimeCreateArguments(runtime: Runtime, policy: LocalRuntimePolicy): string[] {
  return ['container', 'create', '--pull=never', '--name', `flujo-owner-${policy.generation}`,
    '--label', 'io.flujo.local-owner.protocol=1', '--label', `io.flujo.local-owner.runtime=${runtime.id}`,
    '--label', `io.flujo.local-owner.actor=${runtime.actorId}`, '--label', `io.flujo.local-owner.generation=${policy.generation}`,
    '--network=none', '--read-only', '--user=1000:1000', '--workdir=/app', '--ipc=private', '--cgroupns=private',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--restart=no', '--no-healthcheck', '--log-driver=none',
    '--memory', `${policy.memoryMiB}m`, '--memory-swap', `${policy.memoryMiB}m`, '--cpus', String(policy.cpus),
    '--pids-limit', String(policy.pidsLimit), '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
    ...volumeMounts(policy, true), ...fixedEnvironment(runtime).flatMap(value => ['--env', value]),
    policy.imageId, 'node', 'scripts/launch-next.mjs', 'start', '-p', '4200', '-H', '127.0.0.1'];
}

function publishConfiguration(filename: string, original: string, config: ControllerConfig): void {
  assertPrivateDirectory(dirname(filename));
  const temporary = join(dirname(filename), `.controller-${randomBytes(16).toString('hex')}.json`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(configSchema.parse(config), null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  // Preserve a completed private candidate for recovery if concurrent operator
  // edits or publication fail. Never overwrite a different configuration.
  if (readPrivateFile(filename).toString('utf8') !== original) throw new Error('Configuration changed during provisioning.');
  renameSync(temporary, filename);
  const directory = openSync(dirname(filename), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** One-time local provisioning under the controller's process lock. A private
 * journal and deterministic names recover crashes without silently making a
 * second runtime, overwriting existing authority or deleting persistent data. */
export async function provisionRuntime(filename: string, config: ControllerConfig, ledger: Ledger, actorId: string,
  localEngine?: Pick<LocalEngine, 'run' | 'json'>): Promise<Runtime> {
  const original = readPrivateFile(filename).toString('utf8');
  if (JSON.stringify(configSchema.parse(JSON.parse(original))) !== JSON.stringify(config)) {
    throw new Error('Configuration changed before provisioning.');
  }
  if (!config.localEngine) throw new Error('Configure a local engine and preinstalled image first.');
  const runtime = config.runtimes.find(item => item.actorId === actorId);
  if (!runtime) throw new Error('Unknown configured owner.');
  if (runtime.localRuntime) {
    const previous = ledger.db.prepare('SELECT plan,phase FROM runtime_provisioning WHERE runtime_id=?').get(runtime.id);
    if (previous && JSON.stringify(planSchema.parse(JSON.parse(String(previous.plan))).policy) === JSON.stringify(runtime.localRuntime)) {
      ledger.db.prepare('UPDATE runtime_provisioning SET phase=? WHERE runtime_id=?').run('published', runtime.id);
    }
    return runtime;
  }
  if (runtime.isolationId !== `unprovisioned:${runtime.id}` || ledger.db.prepare('SELECT 1 FROM runtimes WHERE id=?').get(runtime.id)) {
    throw new Error('Only a new, unregistered owner can be provisioned. Existing owners require migration.');
  }
  const requested = digest(JSON.stringify({ revision: runtimeRevision(config, runtime), engine: config.localEngine }));
  const stored = ledger.db.prepare('SELECT * FROM runtime_provisioning WHERE runtime_id=?').get(runtime.id);
  let plan: z.infer<typeof planSchema>;
  if (stored) {
    if (stored.request_digest !== requested) throw new Error('Resume provisioning with its original configuration.');
    plan = planSchema.parse(JSON.parse(String(stored.plan)));
  } else {
    const generation = randomBytes(16).toString('hex');
    const { credentialSeconds, ...settings } = config.localEngine;
    plan = planSchema.parse({ issuedAt: Date.now(), policy: { ...settings, kind: 'local-docker',
      containerId: '0'.repeat(64), generation, credentialExpiresAt: Date.now() + credentialSeconds * 1000,
      dataVolume: `flujo-owner-${generation}-data`, homeVolume: `flujo-owner-${generation}-home`,
      authorityVolume: `flujo-owner-${generation}-authority` } });
    ledger.db.prepare('INSERT INTO runtime_provisioning VALUES(?,?,?,?)').run(runtime.id, requested, JSON.stringify(plan), 'planned');
  }
  const { policy } = plan;
  if (policy.credentialExpiresAt <= Date.now()) throw new Error('Provisioning authority expired; preserve the journal for operator recovery.');
  const engine = localEngine ?? new LocalEngine(config.stateDirectory);
  const images = await engine.json(policy, ['image', 'inspect', policy.imageId]);
  if (!Array.isArray(images) || images.length !== 1 || images[0].Id !== policy.imageId
      || images[0].Os !== 'linux' || images[0].Config?.Labels?.['io.flujo.local-owner.protocol'] !== '1'
      || images[0].Config?.Labels?.['io.flujo.build.worker-mode'] !== ''
      || images[0].Config?.Labels?.['io.flujo.build.execution-adapter'] !== ''
      || (images[0].Config?.Volumes && Object.keys(images[0].Config.Volumes).length !== 0)
      || JSON.stringify(images[0].Config?.Entrypoint) !== JSON.stringify(['/usr/bin/tini', '-s', '--'])) {
    throw new Error('Preinstalled image is not a local owner runtime image.');
  }
  for (const name of [policy.dataVolume, policy.homeVolume, policy.authorityVolume]) {
    await engine.run(policy, ['volume', 'create', '--driver=local', '--label', `io.flujo.local-owner.actor=${runtime.actorId}`,
      '--label', `io.flujo.local-owner.generation=${policy.generation}`, name]);
    const rows = await engine.json(policy, ['volume', 'inspect', name]);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].Name !== name || rows[0].Driver !== 'local'
        || (rows[0].Options && Object.keys(rows[0].Options).length !== 0) || rows[0].Scope !== 'local'
        || rows[0].Labels?.['io.flujo.local-owner.actor'] !== runtime.actorId
        || rows[0].Labels?.['io.flujo.local-owner.generation'] !== policy.generation) {
      throw new Error('Local volume ownership does not match.');
    }
  }
  const authority = { schemaVersion: 1, ownerId: runtime.actorId, credentials: [{ id: 'local-controller',
    digest: digest(runtime.credential), scopes: ['openai:read', 'openai:execute', 'mcp:access', 'control:admin', 'secrets:read', 'avatar:voice'],
    issuedAt: plan.issuedAt, expiresAt: policy.credentialExpiresAt, revokedAt: null }] };
  if (String(stored?.phase ?? 'planned') === 'planned') {
    await engine.run(policy, ['container', 'run', '--rm', '--interactive', '--pull=never',
      '--name', `flujo-owner-init-${policy.generation}`, '--network=none', '--read-only', '--user=0:0',
      '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=FOWNER', '--cap-add=DAC_OVERRIDE',
      '--security-opt=no-new-privileges:true', '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1',
      '--no-healthcheck', '--log-driver=none', ...volumeMounts(policy, false), '--entrypoint=/usr/local/bin/node',
      policy.imageId, '/app/packages/shared-controller/dist/runtime-authority.js', 'initialize'], JSON.stringify(authority));
    ledger.db.prepare('UPDATE runtime_provisioning SET phase=? WHERE runtime_id=?').run('initialized', runtime.id);
  }
  const listed = await engine.run(policy, ['container', 'ls', '--all', '--no-trunc', '--filter',
    `name=^/flujo-owner-${policy.generation}$`, '--format', '{{.ID}}']);
  const containerId = listed || await engine.run(policy, runtimeCreateArguments(runtime, policy));
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Local container creation is unconfirmed.');
  policy.containerId = containerId;
  const intent: RuntimeIntent = { runtimeId: runtime.id, actorId, origin: runtime.origin, generation: 1,
    desired: 'stopped', phase: 'pending', verifiedAt: null, problem: null, policy, credentialDigest: digest(runtime.credential) };
  const containers = await engine.json(policy, ['container', 'inspect', containerId]);
  if (!Array.isArray(containers) || containers.length !== 1 || verifyLocalRuntime(containers[0], intent) !== 'stopped') {
    throw new Error('Provisioned runtime must be verified stopped before publication.');
  }
  ledger.db.prepare('UPDATE runtime_provisioning SET plan=?,phase=? WHERE runtime_id=?')
    .run(JSON.stringify(plan), 'created', runtime.id);
  const provisioned = { ...runtime, localRuntime: policy, upstream: 'http://127.0.0.1:4200', isolationId: `local-docker:${containerId}` };
  publishConfiguration(filename, original, { ...config, runtimes: config.runtimes.map(item => item.id === runtime.id ? provisioned : item) });
  ledger.db.prepare('UPDATE runtime_provisioning SET phase=? WHERE runtime_id=?').run('published', runtime.id);
  ledger.audit('runtime.provisioned', actorId, runtime.id);
  return provisioned;
}
