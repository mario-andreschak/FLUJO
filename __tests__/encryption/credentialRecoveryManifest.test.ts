import { randomBytes } from 'node:crypto';
import { CREDENTIAL_RECOVERY_FILES, encryptCredentialRecoveryObject } from '@/utils/encryption/credentialRecoveryFormat';
import {
  advanceCredentialRecoveryManifest, decryptCredentialRecoveryManifest, encryptCredentialRecoveryManifest,
  parseCredentialRecoveryManifest, type CredentialRecoveryManifest,
} from '@/utils/encryption/credentialRecoveryManifest';

function fixture(): CredentialRecoveryManifest {
  return {
    format: 'flujo-credential-recovery-manifest', version: 1,
    workspace: 'private-recovery', transactionId: 'd858dc1f-77d8-4198-9b6d-571fd2fd7a8f',
    sourceKeyId: 'a'.repeat(64), targetKeyId: 'b'.repeat(64), phase: 'prepared',
    entries: CREDENTIAL_RECOVERY_FILES.map(file => ({ file, before: { size: 10, sha256: 'c'.repeat(64) },
      after: { size: 20, sha256: 'd'.repeat(64) } })),
  };
}

test('requires a different active key and the complete fixed store inventory', () => {
  const valid = fixture();
  const decoded = parseCredentialRecoveryManifest(valid, valid);
  expect(decoded).toEqual(valid);
  decoded.entries[0].after!.size = 30;
  expect(valid.entries[0].after!.size).toBe(20);
  for (const modify of [
    (value: CredentialRecoveryManifest) => { value.targetKeyId = value.sourceKeyId!; },
    (value: CredentialRecoveryManifest) => { value.entries.pop(); },
    (value: CredentialRecoveryManifest) => { value.entries[1].file = value.entries[0].file; },
    (value: CredentialRecoveryManifest) => { value.entries.reverse(); },
    (value: CredentialRecoveryManifest) => { value.entries[0].after = null; },
    (value: CredentialRecoveryManifest) => { value.entries[1].after = null; },
    (value: CredentialRecoveryManifest) => { value.entries[1].after!.size = -1; },
    (value: CredentialRecoveryManifest) => { value.entries[1].after!.sha256 = 'synthetic-private-invalid-hash'; },
  ]) {
    const invalid = fixture();
    modify(invalid);
    expect(() => parseCredentialRecoveryManifest(invalid, valid)).toThrow('Credential recovery input is invalid');
  }
});

test('retains absent legacy stores and rejects identity/version/unknown-field substitutions', () => {
  const valid = fixture();
  valid.sourceKeyId = null;
  valid.entries[1].before = null;
  valid.entries[1].after = null;
  expect(parseCredentialRecoveryManifest(valid, valid)).toEqual(valid);
  for (const changes of [{ workspace: 'other-workspace' }, { transactionId: 'other-transaction' },
    { version: 2 }, { extension: 'synthetic-private-extra-field' }, { phase: 'success' }]) {
    expect(() => parseCredentialRecoveryManifest({ ...valid, ...changes }, valid)).toThrow('Credential recovery input is invalid');
  }
});

test('allows authenticated resume or rollback without silently reusing completed intent', () => {
  const valid = fixture();
  const committing = advanceCredentialRecoveryManifest(valid, 'committing');
  expect(advanceCredentialRecoveryManifest(committing, 'committing')).toEqual(committing);
  const committed = advanceCredentialRecoveryManifest(committing, 'committed');
  const rollingBack = advanceCredentialRecoveryManifest(committed, 'rolling-back');
  expect(advanceCredentialRecoveryManifest(rollingBack, 'rolling-back')).toEqual(rollingBack);
  const rolledBack = advanceCredentialRecoveryManifest(rollingBack, 'rolled-back');
  expect(() => advanceCredentialRecoveryManifest(valid, 'committed')).toThrow('Credential recovery input is invalid');
  expect(() => advanceCredentialRecoveryManifest(committed, 'committing')).toThrow('Credential recovery input is invalid');
  expect(() => advanceCredentialRecoveryManifest(rolledBack, 'committing')).toThrow('Credential recovery input is invalid');
  expect(valid.phase).toBe('prepared');
});

test('the complete manifest, including content hashes, remains encrypted under the retained recovery key', () => {
  const manifest = fixture();
  const key = randomBytes(32);
  const wire = encryptCredentialRecoveryManifest(manifest, key);
  expect(wire.toString()).not.toContain(manifest.sourceKeyId);
  expect(wire.toString()).not.toContain(manifest.entries[0].before!.sha256);
  expect(decryptCredentialRecoveryManifest(wire, key, manifest)).toEqual(manifest);
  expect(() => decryptCredentialRecoveryManifest(wire, randomBytes(32), manifest)).toThrow('Credential recovery data is invalid or unauthenticated');
});

test('authenticated malformed manifests refuse without emitting private parser data', () => {
  const manifest = fixture();
  const key = randomBytes(32);
  const identity = { workspace: manifest.workspace, transactionId: manifest.transactionId, role: 'manifest' as const };
  for (const bytes of [Buffer.from('{synthetic-private-invalid-json'), Buffer.from(JSON.stringify({
    ...manifest, targetKeyId: manifest.sourceKeyId,
  }))]) {
    const wire = encryptCredentialRecoveryObject(bytes, key, identity);
    let caught: Error | undefined;
    try { decryptCredentialRecoveryManifest(wire, key, manifest); } catch (error) { caught = error as Error; }
    expect(caught!.message).toBe('Credential recovery data is invalid or unauthenticated; retain it and supply the matching independently retained key.');
    expect(caught!.cause).toBeUndefined();
  }
});
