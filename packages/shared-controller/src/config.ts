import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

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
}).strict();

export const configSchema = z.object({
  schemaVersion: z.literal(2),
  stateDirectory: privatePath,
  // TLS terminates in a separate trusted proxy; the controller binds loopback only.
  port: z.number().int().min(1024).max(65535).default(4280),
  sessionSeconds: z.number().int().min(300).max(28800).default(28800),
  runtimes: z.array(runtimeSchema).min(1).max(1000),
}).strict().superRefine((config, ctx) => {
  for (const key of ['id', 'actorId', 'origin', 'upstream', 'credential', 'isolationId'] as const) {
    if (new Set(config.runtimes.map(runtime => runtime[key])).size !== config.runtimes.length) {
      ctx.addIssue({ code: 'custom', message: `Runtime ${key} values must be unique` });
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
