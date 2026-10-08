import {
  createHash,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const ENDURANCE_EVIDENCE_FILES = Object.freeze([
  'persona-goal-endurance.json',
  'runtime-model-turns.json',
  'runtime-provenance.json',
  'checkpoints/0001.json',
  'checkpoints/0002.json',
  'checkpoints/0003.json',
  'trusted-verifier/manifest.json',
  'trusted-verifier/state.json',
  'trusted-verifier/audit.jsonl',
]);

const sha256 = value => createHash('sha256').update(value).digest('hex');

export function enduranceAttestationKeySha256(publicKey) {
  const key = typeof publicKey === 'string' || Buffer.isBuffer(publicKey)
    ? createPublicKey(publicKey)
    : publicKey;
  return sha256(key.export({ type: 'spki', format: 'der' }));
}

function serializePayload(payload) {
  return JSON.stringify(payload) + '\n';
}

export async function writeEnduranceEvidenceAttestation({
  directory,
  privateKey,
  publicKey,
  runId,
  commitSha,
  sourceDiffSha256,
}) {
  const root = path.resolve(directory);
  const checksumLines = [];
  for (const filename of ENDURANCE_EVIDENCE_FILES) {
    checksumLines.push(sha256(await fs.readFile(path.join(root, filename))) + '  ' + filename);
  }
  const checksumManifest = checksumLines.join('\n') + '\n';
  await fs.writeFile(path.join(root, 'SHA256SUMS'), checksumManifest);

  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const publicKeySha256 = enduranceAttestationKeySha256(publicKey);
  const payload = {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    runId,
    commitSha,
    sourceDiffSha256,
    checksumSha256: sha256(checksumManifest),
    publicKeySha256,
    signedAt: new Date().toISOString(),
  };
  const signature = signBytes(null, Buffer.from(serializePayload(payload)), privateKey);
  const attestation = {
    payload,
    signature: signature.toString('base64'),
  };
  await Promise.all([
    fs.writeFile(path.join(root, 'attestation-public.pem'), publicKeyPem),
    fs.writeFile(
      path.join(root, 'evidence-attestation.json'),
      JSON.stringify(attestation, null, 2) + '\n',
    ),
  ]);
  return { ...attestation, publicKeySha256 };
}

export async function verifyEnduranceEvidenceAttestation({
  directory,
  expectedPublicKeySha256,
}) {
  const root = path.resolve(directory);
  const [checksumManifest, publicKeyPem, rawAttestation] = await Promise.all([
    fs.readFile(path.join(root, 'SHA256SUMS'), 'utf8'),
    fs.readFile(path.join(root, 'attestation-public.pem'), 'utf8'),
    fs.readFile(path.join(root, 'evidence-attestation.json'), 'utf8'),
  ]);
  const attestation = JSON.parse(rawAttestation);
  const publicKey = createPublicKey(publicKeyPem);
  const observedPublicKeySha256 = enduranceAttestationKeySha256(publicKey);
  if (!/^[a-f0-9]{64}$/.test(expectedPublicKeySha256 ?? '')
    || observedPublicKeySha256 !== expectedPublicKeySha256
    || attestation?.payload?.publicKeySha256 !== expectedPublicKeySha256) {
    throw new Error('Evidence attestation key fingerprint does not match the runner-owned anchor.');
  }
  if (attestation?.payload?.schemaVersion !== 1
    || attestation.payload.algorithm !== 'Ed25519'
    || attestation.payload.checksumSha256 !== sha256(checksumManifest)
    || !verifyBytes(
      null,
      Buffer.from(serializePayload(attestation.payload)),
      publicKey,
      Buffer.from(attestation.signature ?? '', 'base64'),
    )) {
    throw new Error('Evidence attestation signature or checksum binding is invalid.');
  }
  return { checksumManifest, attestation };
}
