import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const OWNER_SCOPES = [
  'openai:read', 'openai:execute', 'mcp:access', 'control:admin', 'secrets:read', 'avatar:voice',
] as const;
export type OwnerScope = typeof OWNER_SCOPES[number];

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const credentialSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(z.enum(OWNER_SCOPES)).min(1).max(OWNER_SCOPES.length)
    .refine(value => new Set(value).size === value.length),
  issuedAt: timestamp,
  expiresAt: timestamp,
  revokedAt: timestamp.nullable(),
  // A voice-only private BFF grant selects its workspace durably. This is not
  // generic workspace authorization for the legacy control scopes.
  workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
    .refine(value => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)).optional(),
}).strict().refine(value => value.expiresAt > value.issuedAt)
  .refine(value => value.workspaceId === undefined || value.scopes.every(scope => scope === 'avatar:voice'));

export const ownerPolicySchema = z.object({
  schemaVersion: z.literal(1),
  ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  credentials: z.array(credentialSchema).max(128),
}).strict().superRefine((policy, context) => {
  if (new Set(policy.credentials.map(value => value.id)).size !== policy.credentials.length
      || new Set(policy.credentials.map(value => value.digest)).size !== policy.credentials.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate credential identity' });
  }
});

export type OwnerPolicy = z.infer<typeof ownerPolicySchema>;
export type OwnerCredential = OwnerPolicy['credentials'][number];
export interface OwnerPrincipal {
  readonly ownerId: string;
  readonly credentialId: string;
  readonly scopes: readonly OwnerScope[];
  readonly workspaceId?: string;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Issuance returns plaintext once. Persist only the record in the policy file. */
export function issueOwnerCredential(scopes: readonly OwnerScope[], expiresAt: number, now = Date.now(),
  options: { workspaceId?: string } = {}): {
  token: string; record: OwnerCredential;
} {
  const token = `flo_v1_${randomBytes(32).toString('base64url')}`;
  const record = credentialSchema.parse({
    id: randomBytes(16).toString('hex'), digest: digest(token).toString('hex'),
    scopes: [...scopes], issuedAt: now, expiresAt, revokedAt: null,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  });
  return { token, record };
}

/** No query/cookie/header identity claims participate in this bearer contract. */
export function authenticateOwnerBearer(request: Request, policy: OwnerPolicy, now = Date.now()): OwnerPrincipal | null {
  const match = /^Bearer[ \t]+(flo_v1_[A-Za-z0-9_-]{43})[ \t]*$/i.exec(
    request.headers.get('authorization') ?? '',
  );
  if (!match || !Number.isSafeInteger(now) || now < 0) return null;
  const provided = digest(match[1]);
  const credential = policy.credentials.find(record => timingSafeEqual(
    provided, Buffer.from(record.digest, 'hex'),
  ));
  if (!credential || credential.revokedAt !== null || credential.issuedAt > now
      || credential.expiresAt <= now) return null;
  return Object.freeze({ ownerId: policy.ownerId, credentialId: credential.id,
    scopes: Object.freeze([...credential.scopes]),
    ...(credential.workspaceId === undefined ? {} : { workspaceId: credential.workspaceId }) });
}

export function ownerHasScopes(principal: OwnerPrincipal, scopes: readonly OwnerScope[]): boolean {
  return scopes.every(scope => principal.scopes.includes(scope));
}
