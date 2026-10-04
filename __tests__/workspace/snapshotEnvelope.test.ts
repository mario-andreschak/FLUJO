import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { decryptSnapshotEnvelope, encryptSnapshotEnvelope, parseSnapshotRecipientKey } from '@/backend/services/workspace/snapshotEnvelope';

const plaintext = Buffer.from('synthetic-bootstrap-dek-and-provider-credentials');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('complete payloads round-trip only with the independently retained recipient key', () => {
  const key = randomBytes(32);
  const original = Buffer.from(key);
  const encrypted = encryptSnapshotEnvelope(plaintext, key);
  expect(encrypted.toString()).not.toContain(plaintext.toString());
  expect(encrypted.toString()).not.toContain(key.toString('base64'));
  expect(decryptSnapshotEnvelope(encrypted, key.toString('base64'), 1024)).toEqual({ bytes: plaintext, version: 2 });
  expect(key).toEqual(original);
  expect(digest(encrypted)).not.toBe(digest(plaintext));
  expect(encryptSnapshotEnvelope(plaintext, key)).not.toEqual(encrypted);
});

test.each([undefined, null, 42, {}, '', 'FLUJO~', 'not-base64', 'A'.repeat(43),
  Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')])('rejects invalid recipient key #%# with fixed diagnostics', value => {
  expect(() => parseSnapshotRecipientKey(value)).toThrow('A recipient snapshot key containing 32 random bytes in canonical base64 is required.');
});

test.each(['wrong-key', 'missing-key', 'nonce', 'tag', 'data', 'downgrade', 'unknown-version', 'extra-field', 'wrong-format'] as const)
  ('refuses %s before returning any credential bytes', kind => {
    const key = randomBytes(32);
    const fields = JSON.parse(encryptSnapshotEnvelope(plaintext, key).toString());
    const corrupt = (value: string) => { const bytes = Buffer.from(value, 'base64'); bytes[0] ^= 1; return bytes.toString('base64'); };
    if (kind === 'nonce') fields.iv = corrupt(fields.iv);
    if (kind === 'tag') fields.tag = corrupt(fields.tag);
    if (kind === 'data') fields.data = corrupt(fields.data);
    if (kind === 'downgrade') fields.version = 1;
    if (kind === 'unknown-version') fields.version = 3;
    if (kind === 'extra-field') fields.private = 'synthetic-private-field';
    if (kind === 'wrong-format') fields.format = 'other';
    const recipient = kind === 'wrong-key' ? randomBytes(32).toString('base64') : kind === 'missing-key' ? undefined : key.toString('base64');
    try { decryptSnapshotEnvelope(Buffer.from(JSON.stringify(fields)), recipient, 1024); throw new Error('Expected refusal'); }
    catch (error) {
      expect((error as Error).message).toBe('Worker snapshot decryption failed. Check the encrypted archive and its recipient key.');
      expect((error as Error).cause).toBeUndefined();
    }
  });

test('bounds decoded data and refuses malformed UTF-8, JSON and noncanonical base64', () => {
  const key = randomBytes(32);
  const encrypted = encryptSnapshotEnvelope(plaintext, key);
  expect(() => decryptSnapshotEnvelope(encrypted, key.toString('base64'), 1)).toThrow('decryption failed');
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{synthetic-private-parser-data'), Buffer.from('null')]) {
    expect(() => decryptSnapshotEnvelope(bytes, key.toString('base64'), 1024)).toThrow('decryption failed');
  }
  const fields = JSON.parse(encrypted.toString());
  fields.data += '\n';
  expect(() => decryptSnapshotEnvelope(Buffer.from(JSON.stringify(fields)), key.toString('base64'), 1024)).toThrow('decryption failed');
});

test('retains read compatibility with already-created v1 bridge envelopes', () => {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const old = Buffer.from(JSON.stringify({ format: 'flujo-workspace-encrypted', version: 1,
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  expect(decryptSnapshotEnvelope(old, key.toString('base64'), 1024)).toEqual({ bytes: plaintext, version: 1 });
});
