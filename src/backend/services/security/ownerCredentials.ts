import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  ACCESS_ROLES, LEGACY_OWNER_SCOPES, OWNER_SCOPES, namedCredentialProblem, type OwnerScope,
} from '../../../shared/types/access';

export { OWNER_SCOPES };
export type { OwnerScope };

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const noControlCharacters = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const credentialFields = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(z.enum(OWNER_SCOPES)).min(1).max(OWNER_SCOPES.length)
    .refine(value => new Set(value).size === value.length),
  issuedAt: timestamp,
  expiresAt: timestamp,
  revokedAt: timestamp.nullable(),
  // A voice-only private BFF grant selects its workspace durably. In a schema 2
  // policy this also binds a narrow credential to one workspace; it is still not
  // workspace authorization for the legacy control scopes.
  workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
    .refine(value => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)).optional(),
};
const credentialSchema = z.object(credentialFields).strict().refine(value => value.expiresAt > value.issuedAt)
  .refine(value => value.workspaceId === undefined || value.scopes.every(scope => scope === 'avatar:voice'));

export const OWNER_CREDENTIAL_NAME_MAX_LENGTH = 80;
export const OWNER_CREDENTIAL_MAX_FLOWS = 64;
const namedCredentialSchema = z.object({
  ...credentialFields,
  name: z.string().min(1).max(OWNER_CREDENTIAL_NAME_MAX_LENGTH)
    .refine(value => value === value.trim() && noControlCharacters(value)).optional(),
  role: z.enum([...ACCESS_ROLES, 'custom']).optional(),
  flowIds: z.array(z.string().min(1).max(128).refine(noControlCharacters)).min(1).max(OWNER_CREDENTIAL_MAX_FLOWS)
    .refine(value => new Set(value).size === value.length).optional(),
  createdBy: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
}).strict().refine(value => value.expiresAt > value.issuedAt);

const NAMED_ONLY_FIELDS = ['name', 'role', 'flowIds', 'createdBy'] as const;

/**
 * Schema 1 is the policy as it always was: exact legacy scopes and no people.
 * Schema 2 means named access is on. An older FLUJO refuses schema 2 and fails
 * closed instead of reading a narrow credential as if it were a broad one.
 */
export const ownerPolicySchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  credentials: z.array(namedCredentialSchema).max(128),
}).strict().superRefine((policy, context) => {
  if (new Set(policy.credentials.map(value => value.id)).size !== policy.credentials.length
      || new Set(policy.credentials.map(value => value.digest)).size !== policy.credentials.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate credential identity' });
  }
  for (const credential of policy.credentials) {
    if (policy.schemaVersion === 1) {
      const legacyOnly = credential.scopes.every(scope => (LEGACY_OWNER_SCOPES as readonly string[]).includes(scope))
        && NAMED_ONLY_FIELDS.every(field => credential[field] === undefined)
        && (credential.workspaceId === undefined || credential.scopes.every(scope => scope === 'avatar:voice'));
      if (!legacyOnly) context.addIssue({ code: 'custom', message: 'Named access needs schema version 2' });
    } else {
      const problem = namedCredentialProblem(credential);
      if (problem) context.addIssue({ code: 'custom', message: problem });
    }
  }
});

export type OwnerPolicy = z.infer<typeof ownerPolicySchema>;
export type OwnerCredential = OwnerPolicy['credentials'][number];
export interface OwnerPrincipal {
  readonly ownerId: string;
  readonly credentialId: string;
  readonly scopes: readonly OwnerScope[];
  readonly workspaceId?: string;
  /** Present only when the policy is schema 2, that is, named access is on. */
  readonly named?: true;
  readonly name?: string;
  readonly role?: OwnerCredential['role'];
  readonly flowIds?: readonly string[];
}

/** One projection for bearer and browser session, so neither can drift from the policy. */
export function ownerPrincipalOf(policy: OwnerPolicy, credential: OwnerCredential): OwnerPrincipal {
  return Object.freeze({
    ownerId: policy.ownerId, credentialId: credential.id,
    scopes: Object.freeze([...credential.scopes]),
    ...(credential.workspaceId === undefined ? {} : { workspaceId: credential.workspaceId }),
    ...(policy.schemaVersion === 2 ? {
      named: true as const,
      ...(credential.name === undefined ? {} : { name: credential.name }),
      ...(credential.role === undefined ? {} : { role: credential.role }),
      ...(credential.flowIds === undefined ? {} : { flowIds: Object.freeze([...credential.flowIds]) }),
    } : {}),
  });
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

/** A named credential for a schema 2 policy. The plain secret leaves here once and is never stored. */
export function issueNamedCredential(input: {
  name: string; scopes: readonly OwnerScope[]; expiresAt: number; role?: OwnerCredential['role'];
  workspaceId?: string; flowIds?: readonly string[]; createdBy?: string;
}, now = Date.now()): { token: string; record: OwnerCredential } {
  const token = `flo_v1_${randomBytes(32).toString('base64url')}`;
  const record = namedCredentialSchema.parse({
    id: randomBytes(16).toString('hex'), digest: digest(token).toString('hex'),
    scopes: [...input.scopes], issuedAt: now, expiresAt: input.expiresAt, revokedAt: null,
    name: input.name, ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.flowIds === undefined ? {} : { flowIds: [...input.flowIds] }),
    ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
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
  return ownerPrincipalOf(policy, credential);
}

export function ownerHasScopes(principal: OwnerPrincipal, scopes: readonly OwnerScope[]): boolean {
  return scopes.every(scope => principal.scopes.includes(scope));
}
