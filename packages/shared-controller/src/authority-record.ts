import { z } from 'zod';

export const authorityRecordSchema = z.object({ schemaVersion: z.literal(1), ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  credentials: z.tuple([z.object({ id: z.literal('local-controller'), digest: z.string().regex(/^[a-f0-9]{64}$/),
    scopes: z.tuple([z.literal('openai:read'), z.literal('openai:execute'), z.literal('mcp:access'),
      z.literal('control:admin'), z.literal('secrets:read'), z.literal('avatar:voice')]),
    issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), revokedAt: z.null() }).strict()]),
}).strict().refine(value => value.credentials[0].expiresAt > value.credentials[0].issuedAt);

export function ownerAuthority(ownerId: string, digest: string, issuedAt: number, expiresAt: number): z.infer<typeof authorityRecordSchema> {
  return authorityRecordSchema.parse({ schemaVersion: 1, ownerId, credentials: [{ id: 'local-controller', digest,
    scopes: ['openai:read', 'openai:execute', 'mcp:access', 'control:admin', 'secrets:read', 'avatar:voice'],
    issuedAt, expiresAt, revokedAt: null }] });
}

export const authorityRotationSchema = z.object({ operationId: z.string().regex(/^[a-f0-9]{32}$/),
  previousDigest: z.string().regex(/^[a-f0-9]{64}$/), previousExpiresAt: z.number().int().positive(),
  next: authorityRecordSchema,
}).strict().refine(value => value.previousDigest !== value.next.credentials[0].digest);

/** Idempotence is exact: another generation/owner is never accepted as a retry. */
export function rotatingAuthority(current: z.infer<typeof authorityRecordSchema>, request: z.infer<typeof authorityRotationSchema>): 'current' | 'replace' {
  if (JSON.stringify(current) === JSON.stringify(request.next)) return 'current';
  if (current.ownerId !== request.next.ownerId || current.credentials[0].digest !== request.previousDigest
      || current.credentials[0].expiresAt !== request.previousExpiresAt) throw new Error('Authority rotation identity mismatch.');
  return 'replace';
}
