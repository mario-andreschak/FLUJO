/**
 * Untrusted-input sanitizers for the secret-derivation API routes (issue #195).
 *
 * The wizard posts back the proposals the user accepted; treat them as
 * untrusted. We keep only the fields substitution needs and coerce the secret
 * name through the shared `toProposalSecretName` so a malformed name can never
 * reach the manifest.
 */
import {
  SECRET_KINDS,
  toProposalSecretName,
  secretProposalId,
  type SecretKind,
  type SecretProposal,
} from '@/shared/types/package/secretProposal';

function coerceKind(value: unknown): SecretKind {
  return typeof value === 'string' && (SECRET_KINDS as readonly string[]).includes(value)
    ? (value as SecretKind)
    : 'other';
}

/** Parse an untrusted `acceptedSecrets` array into well-formed `SecretProposal[]`. */
export function sanitizeAcceptedSecrets(value: unknown): SecretProposal[] {
  if (!Array.isArray(value)) return [];
  const out: SecretProposal[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const excerpt = typeof e.excerpt === 'string' ? e.excerpt : '';
    const location = typeof e.location === 'string' ? e.location : '';
    if (!excerpt) continue;
    const kind = coerceKind(e.kind);
    const suggestedSecretName =
      typeof e.suggestedSecretName === 'string' && e.suggestedSecretName.trim()
        ? toProposalSecretName('SECRET', e.suggestedSecretName)
        : toProposalSecretName('SECRET', excerpt.slice(0, 16));
    out.push({
      id: typeof e.id === 'string' && e.id ? e.id : secretProposalId(location, excerpt),
      location,
      excerpt,
      kind,
      source: 'manual',
      suggestedSecretName,
      suggestedDescription:
        typeof e.suggestedDescription === 'string' ? e.suggestedDescription.slice(0, 200) : undefined,
    });
  }
  return out;
}
