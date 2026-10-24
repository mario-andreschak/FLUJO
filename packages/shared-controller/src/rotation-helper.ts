import { z } from 'zod';
import type { LocalEngine } from './local-engine.js';
import { RuntimeControlError, type RuntimeIntent } from './local-runtime-policy.js';
import { authorityRotationSchema } from './authority-record.js';

const helperPath = '/app/packages/shared-controller/dist/runtime-authority.js';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const empty = (value: unknown) => value == null || (typeof value === 'object' && Object.keys(value).length === 0);
const helper = z.object({ Id: z.string(), Name: z.string(), Image: z.string(),
  Config: z.object({ User: z.string(), WorkingDir: z.string(), Env: z.array(z.string()),
    Labels: z.record(z.string(), z.string()), Entrypoint: z.array(z.string()), Cmd: z.array(z.string()),
    Healthcheck: z.object({ Test: z.array(z.string()) }) }),
  HostConfig: z.record(z.string(), z.unknown()),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string(), Destination: z.string(), RW: z.boolean() })),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }),
});

export function rotationHelperArguments(intent: RuntimeIntent, operationId: string): string[] {
  if (!/^[a-f0-9]{32}$/.test(operationId)) throw new Error('Invalid rotation identity.');
  return ['container', 'run', '--rm', '--interactive', '--pull=never', '--name', `flujo-owner-rotate-${operationId}`,
    '--label', 'io.flujo.local-owner.protocol=1', '--label', `io.flujo.local-owner.runtime=${intent.runtimeId}`,
    '--label', `io.flujo.local-owner.actor=${intent.actorId}`, '--label', `io.flujo.local-owner.generation=${intent.policy.generation}`,
    '--label', `io.flujo.local-owner.rotation=${operationId}`,
    '--user=1000:1000', '--workdir=/app', '--network=none', '--read-only', '--ipc=private', '--cgroupns=private',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--restart=no', '--memory=256m', '--memory-swap=256m',
    '--cpus=1', '--pids-limit=64', '--no-healthcheck', '--log-driver=none',
    '--mount', `type=volume,source=${intent.policy.authorityVolume},target=/run/flujo-owner`,
    '--entrypoint=/usr/local/bin/node', intent.policy.imageId, helperPath, 'rotate'];
}

/** A lost CLI reply can leave a daemon-side helper. Never wait on, cancel or
 * adopt an unrelated container merely because its name matches. */
export function verifyRotationHelper(value: unknown, id: string, intent: RuntimeIntent, operationId: string): void {
  const parsed = helper.safeParse(value);
  if (!parsed.success) throw new RuntimeControlError('isolation-mismatch');
  const c = parsed.data; const host = c.HostConfig; const labels = c.Config.Labels;
  const readonlyPaths = host.ReadonlyPaths; const maskedPaths = host.MaskedPaths;
  if (c.Id !== id || !/^[a-f0-9]{64}$/.test(id) || c.Name !== `/flujo-owner-rotate-${operationId}`
      || c.Image !== intent.policy.imageId || labels['io.flujo.local-owner.protocol'] !== '1'
      || labels['io.flujo.local-owner.runtime'] !== intent.runtimeId || labels['io.flujo.local-owner.actor'] !== intent.actorId
      || labels['io.flujo.local-owner.generation'] !== intent.policy.generation
      || labels['io.flujo.local-owner.rotation'] !== operationId
      || labels['io.flujo.build.worker-mode'] !== '' || labels['io.flujo.build.execution-adapter'] !== '') {
    throw new RuntimeControlError('identity-mismatch');
  }
  if (c.Config.User !== '1000:1000' || c.Config.WorkingDir !== '/app'
      || !equal(c.Config.Entrypoint, ['/usr/local/bin/node']) || !equal(c.Config.Cmd, [helperPath, 'rotate'])
      || !equal(c.Config.Healthcheck.Test, ['NONE'])
      || c.Config.Env.some(item => /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH)=/.test(item))
      || host.Privileged !== false || host.ReadonlyRootfs !== true || host.NetworkMode !== 'none'
      || host.PidMode !== '' || host.UTSMode !== '' || host.UsernsMode !== '' || host.IpcMode !== 'private'
      || host.CgroupnsMode !== 'private' || host.PublishAllPorts !== false || host.AutoRemove !== true
      || host.Memory !== 268435456 || host.MemorySwap !== 268435456 || host.NanoCpus !== 1e9 || host.PidsLimit !== 64
      || host.OomKillDisable === true || !empty(host.CapAdd) || !equal(host.CapDrop, ['ALL'])
      || !Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 1
      || !['no-new-privileges', 'no-new-privileges:true'].includes(String(host.SecurityOpt[0]))
      || !equal(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 })
      || ['Binds', 'VolumesFrom', 'PortBindings', 'Devices', 'DeviceRequests', 'DeviceCgroupRules', 'GroupAdd', 'ExtraHosts', 'Tmpfs'].some(key => !empty(host[key]))
      || !equal(Object.keys(c.NetworkSettings.Networks), ['none'])
      || !equal(c.Mounts, [{ Type: 'volume', Name: intent.policy.authorityVolume, Destination: '/run/flujo-owner', RW: true }])
      || !Array.isArray(readonlyPaths) || !['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'].every(path => readonlyPaths.includes(path))
      || !Array.isArray(maskedPaths) || !['/proc/kcore', '/proc/keys', '/proc/timer_list', '/proc/scsi', '/sys/firmware'].every(path => maskedPaths.includes(path))) {
    throw new RuntimeControlError('isolation-mismatch');
  }
}

export async function runRotationHelper(engine: Pick<LocalEngine, 'run' | 'json'>, intent: RuntimeIntent,
  request: z.infer<typeof authorityRotationSchema>): Promise<void> {
  const list = () => engine.run(intent.policy, ['container', 'ls', '--all', '--no-trunc', '--filter',
    `name=^/flujo-owner-rotate-${request.operationId}$`, '--format', '{{.ID}}']);
  const previous = await list();
  if (previous) {
    if (!/^[a-f0-9]{64}$/.test(previous)) throw new RuntimeControlError('identity-mismatch');
    const rows = await engine.json(intent.policy, ['container', 'inspect', previous]);
    if (!Array.isArray(rows) || rows.length !== 1) throw new RuntimeControlError('state-unconfirmed');
    verifyRotationHelper(rows[0], previous, intent, request.operationId);
    // Bounded by LocalEngine. Unconfirmed helpers keep the journal pending.
    await engine.run(intent.policy, ['container', 'wait', previous]);
    if (await list()) throw new RuntimeControlError('state-unconfirmed');
  }
  const output = JSON.parse(await engine.run(intent.policy, rotationHelperArguments(intent, request.operationId), JSON.stringify(request)));
  const next = request.next.credentials[0];
  if (!output || output.actorId !== intent.actorId || output.digest !== next.digest
      || output.issuedAt !== next.issuedAt || output.expiresAt !== next.expiresAt || await list()) {
    throw new RuntimeControlError('state-unconfirmed');
  }
}
