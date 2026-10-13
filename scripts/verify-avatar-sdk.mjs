import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installed = dirname(fileURLToPath(import.meta.resolve('@flujo-ai/avatar-sdk/package.json')));
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const archive = await readFile(resolve(root, 'packages/avatar-sdk/flujo-ai-avatar-sdk-0.1.0.tgz'));
const binding = lock.packages['node_modules/@flujo-ai/avatar-sdk'];
if (binding.resolved !== 'packages/avatar-sdk' || !binding.link) throw new Error('Avatar SDK must resolve to its pinned local package.');
const expectedIntegrity = 'sha512-rhbxH9divV8QN9GevqzhfshZQ5HYjkMw45tutvuMp3d4rAeXnC0cFxKhZe8o1fplL8Rf7KpCNXmLzkeuk3y6sw==';
if (expectedIntegrity !== `sha512-${createHash('sha512').update(archive).digest('base64')}`) throw new Error('Avatar SDK archive differs from its pinned integrity.');
const provenanceBytes = await readFile(resolve(installed, 'PROVENANCE.json'));
if (createHash('sha256').update(provenanceBytes).digest('hex') !== '04948b141aa18c63675aed539a24f42d879542cb5f22d92ea5614584040ef53d') throw new Error('Avatar SDK provenance differs from its pinned archive.');
const provenance = JSON.parse(provenanceBytes);
if (provenance.sourceDirty) throw new Error('Avatar SDK was built from dirty source.');
for (const [file, expected] of Object.entries(provenance.files)) {
  if (file.startsWith('/') || file.split('/').some(part => part === '..')) throw new Error('Invalid SDK member path.');
  if (createHash('sha256').update(await readFile(resolve(installed, file))).digest('hex') !== expected) throw new Error(`Avatar SDK member differs: ${file}`);
}
console.log(`Avatar SDK ${lock.packages['packages/avatar-sdk'].version}: ${Object.keys(provenance.files).length} members verified at ${provenance.revision}.`);
