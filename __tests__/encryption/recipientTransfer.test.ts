import { MAX_TRANSFER_BYTES, openRecipientTransfer, sealRecipientTransfer } from '@/utils/encryption/recipientTransfer';

const passphrase = 'recipient-unique-test-passphrase';
describe('recipient authenticated envelope', () => {
  it('opens using only the recipient passphrase without a source encryption key', async () => {
    const plaintext = Buffer.from(JSON.stringify({ models: [{ ApiKey: 'recipient-transfer-canary' }] }));
    const envelope = await sealRecipientTransfer(plaintext, passphrase);
    expect(envelope.toString()).not.toContain('recipient-transfer-canary');
    expect(await openRecipientTransfer(envelope, passphrase)).toEqual(plaintext);
    expect(await sealRecipientTransfer(plaintext, passphrase)).not.toEqual(envelope);
    expect(plaintext.toString()).toContain('recipient-transfer-canary');
  });
  it('rejects wrong passphrases without returning provisional plaintext', async () => {
    const envelope = await sealRecipientTransfer(Buffer.from('credential-canary'), passphrase);
    await expect(openRecipientTransfer(envelope, 'another-valid-recipient-passphrase')).rejects.toThrow('Invalid transfer or recipient passphrase.');
  });
  it.each([8, 24, 36, 40, 55])('authenticates header, payload and tag byte %i', async offset => {
    const envelope = await sealRecipientTransfer(Buffer.from('credential-canary'), passphrase);
    envelope[offset] ^= 1;
    await expect(openRecipientTransfer(envelope, passphrase)).rejects.toThrow('Invalid transfer or recipient passphrase.');
  });
  it('rejects truncation, trailing data and invalid format', async () => {
    const envelope = await sealRecipientTransfer(Buffer.from('credential-canary'), passphrase);
    for (const malformed of [envelope.subarray(0, -1), Buffer.concat([envelope, Buffer.from('x')]), Buffer.from('not-a-transfer')]) {
      await expect(openRecipientTransfer(malformed, passphrase)).rejects.toThrow('Invalid transfer or recipient passphrase.');
    }
  });
  it('bounds input and passphrase before key derivation', async () => {
    for (const password of ['FLUJO~', 'short', 'x'.repeat(1025)]) {
      await expect(sealRecipientTransfer(Buffer.from('secret'), password)).rejects.toThrow();
    }
    await expect(sealRecipientTransfer(Buffer.alloc(0), passphrase)).rejects.toThrow();
    await expect(sealRecipientTransfer(Buffer.alloc(MAX_TRANSFER_BYTES + 1), passphrase)).rejects.toThrow();
    await expect(openRecipientTransfer(Buffer.alloc(MAX_TRANSFER_BYTES + 57), passphrase)).rejects.toThrow();
  });
});
