import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageDir = process.argv[2];
if (!packageDir) {
  throw new Error('Usage: node embed-shared.mjs <package-directory>');
}

const serversDir = path.dirname(fileURLToPath(import.meta.url));
const targetDist = path.resolve(serversDir, packageDir, 'dist');
const sharedDist = path.resolve(serversDir, 'shared', 'dist');

for (const extension of ['js', 'd.ts', 'js.map', 'd.ts.map']) {
  const source = path.join(sharedDist, `index.${extension}`);
  try {
    await fs.copyFile(source, path.join(targetDist, `shared.${extension}`));
  } catch (error) {
    if ((error instanceof Error && 'code' in error && error.code === 'ENOENT') && extension.endsWith('.map')) continue;
    throw error;
  }
}

for (const fileName of ['shared.js', 'shared.d.ts']) {
  const file = path.join(targetDist, fileName);
  const source = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, source.replaceAll('sourceMappingURL=index.', 'sourceMappingURL=shared.'), 'utf8');
}

for (const entry of await fs.readdir(targetDist, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const file = path.join(targetDist, entry.name);
  const source = await fs.readFile(file, 'utf8');
  const embedded = source.replaceAll("from '@flujo-ai/mcp-shared'", "from './shared.js'");
  await fs.writeFile(file, embedded, 'utf8');
}
