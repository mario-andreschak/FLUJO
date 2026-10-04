import { randomBytes } from 'node:crypto';
import {
  CREDENTIAL_RECOVERY_FILES,
  CREDENTIAL_RECOVERY_FILE_LIMIT,
  CREDENTIAL_RECOVERY_MANIFEST_LIMIT,
  decryptCredentialRecoveryObject,
  encryptCredentialRecoveryObject,
  type CredentialRecoveryIdentity,
} from '@/utils/encryption/credentialRecoveryFormat';

const identity: CredentialRecoveryIdentity = {
  workspace: 'private-recovery', transactionId: 'd858dc1f-77d8-4198-9b6d-571fd2fd7a8f', role: 'before', file: 'models.json',
};
const bytes = Buffer.from('{"ApiKey":"synthetic-private-api-key","extension":{"token":"synthetic-extension-token"}}');

function refusal(task: () => unknown, code = 'RECOVERY_AUTH') {
  let caught: Error & { code?: string } | undefined;
  try { task(); } catch (error) { caught = error as typeof caught; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught!.code).toBe(code);
  expect(caught!.cause).toBeUndefined();
  expect(caught!.message).not.toContain('synthetic-');
}

test('complete credential bytes round-trip under only the independent recovery key', () => {
  const key = randomBytes(32);
  const original = Buffer.from(key);
  const wire = encryptCredentialRecoveryObject(bytes, key, identity);
  expect(wire.toString()).not.toContain('synthetic-private-api-key');
  expect(wire.toString()).not.toContain('synthetic-extension-token');
  expect(wire.toString()).not.toContain(key.toString('hex'));
  expect(decryptCredentialRecoveryObject(wire, key, identity)).toEqual(bytes);
  expect(key).toEqual(original);
  expect(encryptCredentialRecoveryObject(bytes, key, identity)).not.toEqual(wire);
  refusal(() => decryptCredentialRecoveryObject(wire, randomBytes(32), identity));
  refusal(() => decryptCredentialRecoveryObject(wire, Buffer.alloc(0), identity));
});

test.each(CREDENTIAL_RECOVERY_FILES)('preserves exact legacy/plaintext/ciphertext bytes for %s', file => {
  const key = randomBytes(32);
  const before: CredentialRecoveryIdentity = { ...identity, role: 'before', file };
  const opaque = Buffer.from([0x00, 0xff, 0x01, 0x02, 0x03]);
  const decoded = decryptCredentialRecoveryObject(encryptCredentialRecoveryObject(opaque, key, before), key, before);
  expect(decoded).toEqual(opaque); // Codec never parses, repairs or erases corrupt originals.
  decoded.fill(0);
  expect(opaque).toEqual(Buffer.from([0x00, 0xff, 0x01, 0x02, 0x03]));
});

test('binds ciphertext to workspace, transaction, before/after role and exact credential file', () => {
  const key = randomBytes(32);
  const wire = encryptCredentialRecoveryObject(bytes, key, identity);
  for (const changes of [
    { workspace: 'other-workspace' }, { transactionId: 'd858dc1f-77d8-4198-9b6d-571fd2fd7a8e' },
    { role: 'after' as const }, { file: 'registry_account.json' as const },
  ]) refusal(() => decryptCredentialRecoveryObject(wire, key, { ...identity, ...changes }));
  const manifest: CredentialRecoveryIdentity = { workspace: identity.workspace, transactionId: identity.transactionId, role: 'manifest' };
  refusal(() => decryptCredentialRecoveryObject(wire, key, manifest));
  const manifestWire = encryptCredentialRecoveryObject(bytes, key, manifest);
  expect(decryptCredentialRecoveryObject(manifestWire, key, manifest)).toEqual(bytes);
  refusal(() => decryptCredentialRecoveryObject(manifestWire, key, identity));
});

test.each(['iv', 'tag', 'data', 'version', 'format', 'extra', 'missing', 'base64'] as const)(
  'authenticates the complete recovery object and rejects %s mutation', kind => {
    const key = randomBytes(32);
    const fields = JSON.parse(encryptCredentialRecoveryObject(bytes, key, identity).toString());
    if (kind === 'iv' || kind === 'tag') fields[kind] = `${fields[kind][0] === '0' ? '1' : '0'}${fields[kind].slice(1)}`;
    if (kind === 'data') fields.data = `${fields.data[0] === 'A' ? 'B' : 'A'}${fields.data.slice(1)}`;
    if (kind === 'version') fields.version = 2;
    if (kind === 'format') fields.format = 'flujo-workspace-encrypted';
    if (kind === 'extra') fields.private = 'synthetic-sensitive-parser-input';
    if (kind === 'missing') delete fields.tag;
    if (kind === 'base64') fields.data += '\n';
    refusal(() => decryptCredentialRecoveryObject(Buffer.from(JSON.stringify(fields)), key, identity));
  },
);

test('rejects malformed wire and unsafe identities without payload-bearing diagnostics', () => {
  const key = randomBytes(32);
  for (const wire of [Buffer.from([0xff]), Buffer.from('{synthetic-sensitive-invalid-json'), Buffer.from('null'), Buffer.from('[]')]) {
    refusal(() => decryptCredentialRecoveryObject(wire, key, identity));
  }
  for (const changes of [{ workspace: '../private' }, { transactionId: 'synthetic-private-id' },
    { transactionId: { toString: () => identity.transactionId } },
    { file: '../encryption_key.json' }, { private: 'synthetic-private-extension' }]) {
    refusal(() => encryptCredentialRecoveryObject(bytes, key, { ...identity, ...changes } as CredentialRecoveryIdentity), 'RECOVERY_INPUT');
  }
  refusal(() => encryptCredentialRecoveryObject(bytes, Buffer.alloc(31), identity), 'RECOVERY_INPUT');
});

test('bounds file and manifest objects separately before encrypting or parsing wire', () => {
  const key = randomBytes(32);
  const manifest: CredentialRecoveryIdentity = { workspace: identity.workspace, transactionId: identity.transactionId, role: 'manifest' };
  refusal(() => encryptCredentialRecoveryObject(Buffer.alloc(CREDENTIAL_RECOVERY_FILE_LIMIT + 1), key, identity), 'RECOVERY_SIZE');
  refusal(() => encryptCredentialRecoveryObject(Buffer.alloc(CREDENTIAL_RECOVERY_MANIFEST_LIMIT + 1), key, manifest), 'RECOVERY_SIZE');
  refusal(() => decryptCredentialRecoveryObject(Buffer.alloc(4 * Math.ceil(CREDENTIAL_RECOVERY_MANIFEST_LIMIT / 3) + 4097), key, manifest), 'RECOVERY_SIZE');
  const exact = Buffer.alloc(CREDENTIAL_RECOVERY_MANIFEST_LIMIT, 0x61);
  const wire = encryptCredentialRecoveryObject(exact, key, manifest);
  expect(decryptCredentialRecoveryObject(wire, key, manifest)).toEqual(exact);
});
