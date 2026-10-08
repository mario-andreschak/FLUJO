/** Synthetic private credentials for the offline worker smoke, never operator data. */
import { createCipheriv, createHash, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function seal(value, key, purpose) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(purpose));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v2:${nonce.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('base64')}`;
}

export async function createPrivateSmokeProfile(passphrase = randomBytes(32).toString('hex')) {
  const activeKey = randomBytes(32);
  const salt = randomBytes(16);
  let wrappingKey;
  try {
    wrappingKey = await derive(passphrase, salt, 600_000, 32, 'sha256');
    const ring = { version: 2, activeKey: activeKey.toString('hex') };
    const keyId = sha256(activeKey);
    const metadata = {
      encryption_version: 2, encryption_type: 'user', key_id: keyId,
      kdf: 'pbkdf2-sha256', kdf_iterations: 600_000, key_protection: 'passphrase',
      data_encryption_salt: salt.toString('hex'),
      data_encryption_key: seal(JSON.stringify(ring), wrappingKey, `flujo:keyring:v2:user:${keyId}:passphrase`),
    };
    return {
      metadata,
      bootstrap: { version: 1, workspaceDek: `v2:${JSON.stringify({ ...ring, metadataRevision: sha256(JSON.stringify(metadata)) })}` },
      encryptedApiKey: `encrypted:${seal('synthetic-smoke-key', activeKey, 'flujo:secret:v2')}`,
    };
  } finally {
    activeKey.fill(0); salt.fill(0); wrappingKey?.fill(0);
  }
}
