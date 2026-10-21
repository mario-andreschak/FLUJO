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
    return url.origin === value && (url.protocol === 'https:'
      || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
});

const runtimeSchema = z.object({
  id,
  // These identities cannot be renamed or rebound to another person in the ledger.
  actorId: id,
  subject: z.string().min(1).max(255),
  origin: httpsOrigin,
  upstream: upstreamOrigin,
  credential: z.string().regex(/^flo_v1_[A-Za-z0-9_-]{43}$/),
  caFile: privatePath.optional(),
  // Operator's immutable VM/container identity. This is not proof of isolation.
  isolationId: z.string().min(1).max(255),
}).strict();

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  issuer: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(4096),
  stateDirectory: privatePath,
  // TLS terminates in a separate trusted proxy; the controller binds loopback only.
  port: z.number().int().min(1024).max(65535).default(4280),
  sessionSeconds: z.number().int().min(300).max(28800).default(28800),
  runtimes: z.array(runtimeSchema).min(1).max(1000),
}).strict().superRefine((config, ctx) => {
  for (const key of ['id', 'actorId', 'subject', 'origin', 'upstream', 'credential', 'isolationId'] as const) {
    if (new Set(config.runtimes.map(runtime => runtime[key])).size !== config.runtimes.length) {
      ctx.addIssue({ code: 'custom', message: `Runtime ${key} values must be unique` });
    }
  }
});

export type ControllerConfig = z.infer<typeof configSchema>;
export type Runtime = ControllerConfig['runtimes'][number];

export function runtimeRevision(config: ControllerConfig, runtime: Runtime): string {
  // Any endpoint, credential or OIDC-client change expires existing browser authority.
  return createHash('sha256').update(JSON.stringify({
    issuer: config.issuer, clientId: config.clientId, clientSecret: config.clientSecret,
    sessionSeconds: config.sessionSeconds, runtime,
  })).digest('hex');
}
