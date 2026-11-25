import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Synchronous fixture digests in the exact format of
 * fingerprintTrustedHostSourceAsync / fingerprintTrustedHostExecutableAsync.
 * Fixtures install approvals synchronously; every production launch, consent
 * and dispatch check recomputes these digests with the async inspectors, so a
 * format difference fails the trusted-host suites instead of passing silently.
 */
export function fingerprintTrustedHostExecutable(filename: string): string {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

export function fingerprintTrustedHostSource(sourceRoot: string): string {
  const root = path.resolve(sourceRoot);
  const tree = createHash('sha256').update('flujo:mcp:trusted-host-source:v1\0');
  const visit = (directory: string): void => {
    const before = fs.lstatSync(directory, { bigint: true });
    tree.update(JSON.stringify(['directory', path.relative(root, directory).split(path.sep).join('/'), String(before.mode)]));
    const names = fs.readdirSync(directory).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error('Fixture sources contain no links.');
      if (stat.isDirectory()) { visit(filename); continue; }
      const content = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      tree.update(JSON.stringify(['file', path.relative(root, filename).split(path.sep).join('/'), String(stat.mode), content]));
    }
  };
  visit(root);
  return tree.digest('hex');
}
