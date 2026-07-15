/**
 * Recurrence guard (issue #104).
 *
 * jest.config.mjs only matches `<rootDir>/__tests__/**` /*.test.ts, so any `*.test.ts`
 * or `*.spec.ts` placed under `src/` is a mislabeled/orphaned test that never runs
 * (that is exactly what PromptRenderer.test.ts was). This meta-test walks `src/` and
 * fails if any such file reappears — keeping the guard inside `npm test` with the rest
 * of the suite, no CI wiring required.
 */

import { promises as fs } from 'fs';
import path from 'path';

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');
const TEST_FILE = /\.(test|spec)\.tsx?$/;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full)));
    } else if (TEST_FILE.test(entry.name)) {
      found.push(path.relative(SRC_DIR, full).replace(/\\/g, '/'));
    }
  }
  return found;
}

describe('test hygiene', () => {
  it('has no orphaned *.test.ts / *.spec.ts files under src/', async () => {
    const orphaned = await walk(SRC_DIR);
    expect(orphaned).toEqual([]);
  });
});
