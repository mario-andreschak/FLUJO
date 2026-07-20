/**
 * Recurrence guard (issue #176).
 *
 * The companion noOrphanedTests guard walks `src/` for mislabeled tests. This
 * one closes the *other* door: a test file placed correctly under `__tests__/`
 * that no Jest project's `testMatch` actually collects — which is how
 * `.test.tsx` used to be silently skipped (the matcher only listed `.test.ts`).
 *
 * It walks `__tests__/` for every `*.test.ts(x)` / `*.spec.ts(x)` and asserts
 * each is reachable by the union of the project globs declared in the single
 * source of truth (jest.testMatch.mjs) that jest.config.mjs also imports, so
 * the config and this check can never drift apart. Any unmatched file fails the
 * suite loudly, listed by path.
 */

import { promises as fs } from 'fs';
import path from 'path';
import micromatch from 'micromatch';
import { ALL_TEST_GLOBS } from '../../jest.testMatch.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const TESTS_DIR = path.join(ROOT, '__tests__');
const TEST_FILE = /\.(test|spec)\.tsx?$/;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full)));
    } else if (TEST_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

describe('testMatch coverage', () => {
  it('collects every *.test.ts(x) / *.spec.ts(x) under __tests__/ via a project glob', async () => {
    const files = await walk(TESTS_DIR);
    // Sanity: the walker actually found the suite (guards against a broken walk).
    expect(files.length).toBeGreaterThan(0);

    const relPosix = files.map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
    const unmatched = relPosix.filter((rel) => !micromatch.isMatch(rel, ALL_TEST_GLOBS));

    // If this fails, either move the file under a matched path or broaden a
    // glob in jest.testMatch.mjs — do NOT just delete the assertion.
    expect(unmatched).toEqual([]);
  });
});
