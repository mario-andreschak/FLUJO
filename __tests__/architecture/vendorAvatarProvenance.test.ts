import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * src/vendor/avatar is generated from flujo-avatar and kept byte for byte, so
 * eslint.config.mjs lets a few of its files skip React lint rules there. That
 * exception only holds while the copy matches PROVENANCE.json: a local edit
 * belongs in flujo-avatar, followed by a resync.
 */
const ROOT = process.cwd();
const VENDOR = path.join(ROOT, 'src', 'vendor', 'avatar');

function localPath(member: string): string {
  if (member.startsWith('src/')) return path.join(VENDOR, member.slice('src/'.length));
  return path.join(ROOT, member);
}

describe('vendored flujo-avatar copy', () => {
  it('matches the hashes in PROVENANCE.json', () => {
    const provenance = JSON.parse(fs.readFileSync(path.join(VENDOR, 'PROVENANCE.json'), 'utf8')) as { files: Record<string, string> };
    const members = Object.entries(provenance.files);
    expect(members.length).toBeGreaterThan(0);
    const changed = members.flatMap(([member, expected]) => {
      const file = localPath(member);
      const bytes = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const actual = createHash('sha256').update(bytes).digest('hex');
      return actual === expected ? [] : [path.relative(ROOT, file)];
    });
    if (changed.length > 0) {
      throw new Error('These vendored flujo-avatar files differ from PROVENANCE.json. Make the change in '
        + `flujo-avatar and resync with "npm run sync:flujo -- <FLUJO checkout>" there:\n${changed.join('\n')}`);
    }
  });
});
