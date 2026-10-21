import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { localRuntimePolicySchema } from './local-runtime-policy.js';
import { modelGrantSchema } from './model-grant.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const privatePath = z.string().min(1).refine(value => isAbsolute(value) && !value.includes('\0'));
const httpsOrigin = z.string().refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; }
  catch { return false; }
});
const upstreamOrigin = z.string().refine(value => {
  try {
    const url = new URL(value);
    return url.origin === value && ['http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
});

const runtimeSchema = z.object({
  id,
  // These identities cannot be renamed or rebound to another person in the ledger.
  actorId: id,
  origin: httpsOrigin,
  upstream: upstreamOrigin,
  credential: z.string().regex(/^flo_v1_[A-Za-z0-9_-]{43}$/),
  caFile: privatePath.optional(),
  // Operator's immutable local OS isolation identity, not proof of isolation.
  isolationId: z.string().min(1).max(255),
  localRuntime: localRuntimePolicySchema.optional(),
  modelGrants: z.array(modelGrantSchema).max(32).optional(),
}).strict().superRefine((runtime, context) => {
  if (runtime.modelGrants?.length && (!runtime.localRuntime
      || new Set(runtime.modelGrants.map(grant => grant.id)).size !== runtime.modelGrants.length)) {
    context.addIssue({ code: 'custom', message: 'Model grants require a managed runtime and unique grant identities' });
  }
  if (runtime.localRuntime && (runtime.isolationId !== `local-docker:${runtime.localRuntime.containerId}`
      || runtime.upstream !== 'http://127.0.0.1:4200' || runtime.caFile !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Managed runtime requires its exact local container identity and internal HTTP endpoint' });
  }
});

export const configSchema = z.object({
  schemaVersion: z.literal(2),
  stateDirectory: privatePath,
  localEngine: z.object({
    executable: localRuntimePolicySchema.shape.executable,
    daemon: localRuntimePolicySchema.shape.daemon,
    imageId: localRuntimePolicySchema.shape.imageId,
    memoryMiB: localRuntimePolicySchema.shape.memoryMiB,
    cpus: localRuntimePolicySchema.shape.cpus,
    pidsLimit: localRuntimePolicySchema.shape.pidsLimit,
    credentialSeconds: z.number().int().min(3600).max(31_536_000).default(31_536_000),
  }).strict().optional(),
  // New installations terminate TLS locally. Legacy proxy configurations remain
  // explicit; enabling TLS never silently changes an enrolled owner's origin.
  tls: z.object({ directory: privatePath, executable: privatePath }).strict().optional(),
  port: z.number().int().min(1024).max(65535).default(4280),
  sessionSeconds: z.number().int().min(300).max(28800).default(28800),
  runtimes: z.array(runtimeSchema).min(1).max(1000),
}).strict().superRefine((config, ctx) => {
  if (config.runtimes.filter(runtime => runtime.modelGrants?.length).length > 64) {
    ctx.addIssue({ code: 'custom', message: 'At most 64 managed owners may have model relay grants per controller' });
  }
  if (config.tls && config.runtimes.some(runtime => {
    try {
      const url = new URL(runtime.origin);
      return !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/.test(url.hostname) || Number(url.port || 443) !== config.port;
    } catch { return true; }
  })) ctx.addIssue({ code: 'custom', message: 'Local TLS requires distinct localhost names on the configured controller port' });
  for (const key of ['id', 'actorId', 'origin', 'upstream', 'credential', 'isolationId'] as const) {
    const values = config.runtimes.filter(runtime => key !== 'upstream'
      || (!runtime.localRuntime && runtime.isolationId !== `unprovisioned:${runtime.id}`)).map(runtime => runtime[key]);
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: 'custom', message: `Runtime ${key} values must be unique` });
    }
  }
  const managed = config.runtimes.filter(runtime => runtime.localRuntime).map(runtime => runtime.localRuntime!);
  for (const key of ['containerId', 'generation', 'dataVolume', 'homeVolume', 'authorityVolume'] as const) {
    if (new Set(managed.map(policy => policy[key])).size !== managed.length) {
      ctx.addIssue({ code: 'custom', message: `Local runtime ${key} values must be unique` });
    }
  }
  // Cookies are scoped to hosts, not ports. Two owners on one hostname would
  // send each other's cookies to their sibling port even with distinct origins.
  const hostnames = config.runtimes.map(runtime => {
    try { return new URL(runtime.origin).hostname; }
    catch { return ''; } // The origin field reports invalid URLs without throwing.
  });
  if (new Set(hostnames).size !== config.runtimes.length) {
    ctx.addIssue({ code: 'custom', message: 'Each owner needs a distinct browser hostname' });
  }
});

export type ControllerConfig = z.infer<typeof configSchema>;
export type Runtime = ControllerConfig['runtimes'][number];

export function runtimeRevision(config: ControllerConfig, runtime: Runtime): string {
  // Any endpoint, runtime credential or session-policy change expires authority.
  return createHash('sha256').update(JSON.stringify({
    sessionSeconds: config.sessionSeconds, runtime,
  })).digest('hex');
}
