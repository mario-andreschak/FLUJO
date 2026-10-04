import { readFileSync } from 'node:fs';
import path from 'node:path';
import applicationPackage from '../../package.json';
import { getWorkerCompatibility } from '@/backend/services/workspace/workerCompatibility';

describe('worker image compatibility metadata', () => {
  const originalRevision = process.env.FLUJO_BUILD_REVISION;

  afterEach(() => {
    if (originalRevision === undefined) delete process.env.FLUJO_BUILD_REVISION;
    else process.env.FLUJO_BUILD_REVISION = originalRevision;
  });

  it('reports the implemented contract without claiming a checkout/build revision', () => {
    delete process.env.FLUJO_BUILD_REVISION;
    expect(getWorkerCompatibility()).toEqual({
      applicationVersion: applicationPackage.version,
      snapshotFormatVersion: 2,
      layoutVersion: 2,
      workerProtocolVersion: 1,
      snapshotEncryption: {
        format: 'flujo-workspace-encrypted', cipher: 'aes-256-gcm', writeVersion: 2,
        readVersions: [1, 2], legacyPlaintextRead: true,
        recipientKeyRequired: true, recipientKeyBytes: 32, recipientKeyEncoding: 'base64',
        v2Aad: 'flujo:workspace-snapshot:v2', v2Digest: 'sha256-encrypted-wire', v1Digest: 'sha256-plaintext-zip',
      },
      snapshotLimits: {
        maxFileBytes: 256 * 1024 * 1024, maxUncompressedBytes: 1024 * 1024 * 1024,
        maxManifestBytes: 8 * 1024 * 1024, maxArchiveBytes: 1032 * 1024 * 1024,
        maxEncryptedBytes: 4 * Math.ceil(1032 * 1024 * 1024 / 3) + 4096, maxMembers: 65_534,
      },
      workerSnapshotSourceVersion: 1,
    });
  });

  it('includes an explicit full build revision', () => {
    process.env.FLUJO_BUILD_REVISION = 'a'.repeat(40);
    expect(getWorkerCompatibility()).toMatchObject({ revision: 'a'.repeat(40) });
  });

  it('official image envelope versions match the actual source restore capability', () => {
    const dockerfile = readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
    const label = dockerfile.match(/io\.flujo\.worker\.snapshot-envelope-read-versions="([^"]+)"/);
    expect(label).not.toBeNull();
    expect(label![1]).toBe(getWorkerCompatibility().snapshotEncryption.readVersions.join(','));
  });

  it.each(['abc1234', 'main', 'a'.repeat(39), 'a'.repeat(41), '../private', 'sensitive invalid value']) (
    'omits malformed build revision metadata (%s)', (revision) => {
      process.env.FLUJO_BUILD_REVISION = revision;
      expect(getWorkerCompatibility()).not.toHaveProperty('revision');
    },
  );
});
