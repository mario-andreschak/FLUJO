import {
  CREDENTIAL_RECOVERY_FILES, CREDENTIAL_RECOVERY_FILE_LIMIT,
  assertCredentialRecoveryIdentity, decryptCredentialRecoveryObject, encryptCredentialRecoveryObject,
  CredentialRecoveryFormatError, type CredentialRecoveryFile,
} from './credentialRecoveryFormat';

export type CredentialRecoveryPhase = 'prepared' | 'committing' | 'committed' | 'rolling-back' | 'rolled-back';
export interface CredentialRecoveryWitness { size: number; sha256: string }
export interface CredentialRecoveryEntry {
  file: CredentialRecoveryFile;
  before: CredentialRecoveryWitness | null;
  after: CredentialRecoveryWitness | null;
}
/** Private authenticated manifest, never a status DTO or unencrypted journal. */
export interface CredentialRecoveryManifest {
  format: 'flujo-credential-recovery-manifest';
  version: 1;
  workspace: string;
  transactionId: string;
  sourceKeyId: string | null;
  targetKeyId: string;
  phase: CredentialRecoveryPhase;
  entries: CredentialRecoveryEntry[];
}

const HASH = /^[a-f0-9]{64}$/;
const PHASES: readonly CredentialRecoveryPhase[] = ['prepared', 'committing', 'committed', 'rolling-back', 'rolled-back'];
function closed(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function witness(value: unknown): value is CredentialRecoveryWitness | null {
  return value === null || (closed(value, ['size', 'sha256']) && Number.isSafeInteger(value.size)
    && (value.size as number) >= 0 && (value.size as number) <= CREDENTIAL_RECOVERY_FILE_LIMIT
    && typeof value.sha256 === 'string' && HASH.test(value.sha256));
}

/** Caller supplies the identity already authenticated by the recovery-object codec. */
export function parseCredentialRecoveryManifest(
  value: unknown, expected: { workspace: string; transactionId: string },
): CredentialRecoveryManifest {
  try {
    assertCredentialRecoveryIdentity({ workspace: expected.workspace, transactionId: expected.transactionId, role: 'manifest' });
    if (!closed(value, ['format', 'version', 'workspace', 'transactionId', 'sourceKeyId', 'targetKeyId', 'phase', 'entries'])
        || value.format !== 'flujo-credential-recovery-manifest' || value.version !== 1
        || value.workspace !== expected.workspace || value.transactionId !== expected.transactionId
        || (value.sourceKeyId !== null && (typeof value.sourceKeyId !== 'string' || !HASH.test(value.sourceKeyId)))
        || typeof value.targetKeyId !== 'string' || !HASH.test(value.targetKeyId)
        || value.targetKeyId === value.sourceKeyId || !PHASES.includes(value.phase as CredentialRecoveryPhase)
        || !Array.isArray(value.entries) || value.entries.length !== CREDENTIAL_RECOVERY_FILES.length) throw new Error();
    const entries = value.entries.map((entry: unknown, index: number) => {
      if (!closed(entry, ['file', 'before', 'after']) || entry.file !== CREDENTIAL_RECOVERY_FILES[index]
          || !witness(entry.before) || !witness(entry.after)
          // Migration cannot erase a present store. Rollback can restore an
          // original absence, but the forward intent must retain original data.
          || (entry.before !== null && entry.after === null)
          || (entry.file === 'encryption_key.json' && entry.after === null)) throw new Error();
      return { file: entry.file, before: entry.before && { ...entry.before }, after: entry.after && { ...entry.after } } as CredentialRecoveryEntry;
    });
    return { format: 'flujo-credential-recovery-manifest', version: 1, workspace: value.workspace as string,
      transactionId: value.transactionId as string, sourceKeyId: value.sourceKeyId as string | null,
      targetKeyId: value.targetKeyId, phase: value.phase as CredentialRecoveryPhase, entries };
  } catch { throw new CredentialRecoveryFormatError('RECOVERY_INPUT'); }
}

export function encryptCredentialRecoveryManifest(manifest: CredentialRecoveryManifest, key: Buffer): Buffer {
  const valid = parseCredentialRecoveryManifest(manifest, manifest);
  const bytes = Buffer.from(JSON.stringify(valid));
  try { return encryptCredentialRecoveryObject(bytes, key, { workspace: valid.workspace, transactionId: valid.transactionId, role: 'manifest' }); }
  finally { bytes.fill(0); }
}

export function decryptCredentialRecoveryManifest(
  wire: Buffer, key: Buffer, expected: { workspace: string; transactionId: string },
): CredentialRecoveryManifest {
  const bytes = decryptCredentialRecoveryObject(wire, key, { workspace: expected.workspace, transactionId: expected.transactionId, role: 'manifest' });
  try {
    return parseCredentialRecoveryManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), expected);
  } catch { throw new CredentialRecoveryFormatError('RECOVERY_AUTH'); }
  finally { bytes.fill(0); }
}

/** Terminal rollback requires a new transaction for another forward migration. */
export function advanceCredentialRecoveryManifest(
  manifest: CredentialRecoveryManifest, phase: CredentialRecoveryPhase,
): CredentialRecoveryManifest {
  const current = parseCredentialRecoveryManifest(manifest, manifest);
  const allowed: Record<CredentialRecoveryPhase, readonly CredentialRecoveryPhase[]> = {
    prepared: ['committing', 'rolling-back'],
    committing: ['committing', 'committed', 'rolling-back'],
    committed: ['rolling-back'],
    'rolling-back': ['rolling-back', 'rolled-back'],
    'rolled-back': [],
  };
  if (!allowed[current.phase].includes(phase)) throw new CredentialRecoveryFormatError('RECOVERY_INPUT');
  return { ...current, phase };
}
