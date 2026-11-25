import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface LockEntry { version?: string; dependencies?: Record<string, string> }

async function lockedPackages(): Promise<Record<string, LockEntry>> {
  const lock = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package-lock.json'), 'utf8')) as { packages: Record<string, LockEntry> };
  return lock.packages;
}

test('the split MCP SDK packages and Apps share one @modelcontextprotocol/core', async () => {
  const packages = await lockedPackages();
  const copies = Object.keys(packages).filter(location => location.endsWith('node_modules/@modelcontextprotocol/core'));
  // Two copies give Apps, client and server different protocol classes, so errors and
  // schemas from one are not recognised by the other. Fix: set @modelcontextprotocol/core
  // in package.json to the version @modelcontextprotocol/client and /server pin.
  expect(copies).toEqual(['node_modules/@modelcontextprotocol/core']);
  const installed = packages['node_modules/@modelcontextprotocol/core'].version;
  for (const dependent of ['client', 'server']) {
    expect(packages[`node_modules/@modelcontextprotocol/${dependent}`].dependencies?.['@modelcontextprotocol/core']).toBe(installed);
  }
});
