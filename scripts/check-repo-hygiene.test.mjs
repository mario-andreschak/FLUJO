import assert from 'node:assert/strict';
import test from 'node:test';
import { findProblems } from './check-repo-hygiene.mjs';

const files = (...paths) => paths.map((file, index) => ({ path: file, blob: `blob${index}` }));
const everywhere = () => true;

test('published media, product guides and source pass', () => {
  assert.deepEqual(findProblems(files('docs/images/readme/chat.png', 'public/mcp-icons/a.png', 'src/app/icon.png', 'docs/features/mcp.md', 'src/backend/handoff.ts'), everywhere), []);
});

test('run records, test output folders and handovers are flagged', () => {
  const found = findProblems(files('dev.log', 'soak-artifacts/day1.json', 'reports/jest-results.json', 'notes/HANDOVER-2026-11.md', 'docs/session-handover.md'), everywhere);
  assert.deepEqual(found.map(({ file }) => file), ['dev.log', 'soak-artifacts/day1.json', 'reports/jest-results.json', 'notes/HANDOVER-2026-11.md', 'docs/session-handover.md']);
});

test('product files that mention handoffs are not handovers', () => {
  assert.deepEqual(findProblems(files('docs/features/flow-handoff.md', '__tests__/shared/handoffPrompt.test.ts'), everywhere), []);
});

test('proof screenshots outside the media folders are flagged', () => {
  const [problem] = findProblems(files('evidence/run-4/after.png'), everywhere);
  assert.match(problem.problem, /outside/);
});

test('media that no page uses is flagged unless listed as known debt', () => {
  const unused = () => false;
  assert.equal(findProblems(files('docs/images/old.png'), unused).length, 1);
  assert.deepEqual(findProblems(files('docs/images/old.png'), unused, { unreferencedMedia: ['docs/images/old.png'] }), []);
});

test('fixed debt must be removed from the list', () => {
  const [gone] = findProblems(files(), everywhere, { unreferencedMedia: ['docs/images/old.png'] });
  assert.match(gone.problem, /remove it from/);
  const [used] = findProblems(files('docs/images/old.png'), everywhere, { unreferencedMedia: ['docs/images/old.png'] });
  assert.match(used.problem, /remove it from/);
});

test('identical copies of a media file are flagged', () => {
  const found = findProblems([{ path: 'docs/images/a.png', blob: 'same' }, { path: 'githubpages/img/a-copy.png', blob: 'same' }], everywhere);
  assert.deepEqual(found.map(({ file }) => file), ['githubpages/img/a-copy.png']);
});
