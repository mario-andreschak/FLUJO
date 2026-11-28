import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONTRACT_FILE, GUIDE, countLines, describeProblems, findMissingGuideFiles, findRaisedCeilings, findSizeProblems,
  findUndocumentedModules, guideFileNames, lowerCeilings, run,
} from './check-hotspot-sizes.mjs';

const hotspots = [{ file: 'src/a.ts', maxLines: 10 }, { file: 'src/b.ts', maxLines: 5 }];

test('counts lines like wc -l', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one\n'), 1);
  assert.equal(countLines('one\ntwo'), 2);
  assert.equal(countLines('one\r\ntwo\r\n'), 2);
});

test('a file at its ceiling passes; growth and a stale ceiling fail', () => {
  assert.deepEqual(findSizeProblems(hotspots, (file) => (file === 'src/a.ts' ? 10 : 5)), []);
  assert.deepEqual(findSizeProblems(hotspots, (file) => (file === 'src/a.ts' ? 11 : 4)), [
    { file: 'src/a.ts', kind: 'grew', lines: 11, maxLines: 10 },
    { file: 'src/b.ts', kind: 'stale', lines: 4, maxLines: 5 },
  ]);
});

test('a branch may lower or add a ceiling but never raise or drop one', () => {
  assert.deepEqual(findRaisedCeilings(hotspots, [{ file: 'src/a.ts', maxLines: 9 }, { file: 'src/b.ts', maxLines: 5 }, { file: 'src/c.ts', maxLines: 99 }]), []);
  assert.deepEqual(findRaisedCeilings(hotspots, [{ file: 'src/a.ts', maxLines: 12 }]), [
    { file: 'src/a.ts', before: 10, after: 12 },
    { file: 'src/b.ts', before: 5, after: undefined },
  ]);
});

test('writing lowers stale ceilings only', () => {
  const lowered = lowerCeilings({ hotspots }, (file) => (file === 'src/a.ts' ? 7 : 9));
  assert.deepEqual(lowered.hotspots, [{ file: 'src/a.ts', maxLines: 7 }, { file: 'src/b.ts', maxLines: 5 }]);
});

test('the message says how to fix the cause', () => {
  const text = describeProblems(
    [{ file: 'src/a.ts', kind: 'grew', lines: 11, maxLines: 10 }, { file: 'src/b.ts', kind: 'stale', lines: 4, maxLines: 5 }],
    [{ file: 'src/c.ts', before: 3, after: 4 }],
  );
  assert.match(text, /Move the new code into a module/);
  assert.match(text, /move a nearby block of the same kind out with it/);
  assert.match(text, /Do not raise the ceiling/);
  assert.match(text, /npm run check:hotspots -- --write/);
  assert.match(text, /src\/c\.ts {2}3 -> 4/);
});

test('run checks a checkout, and --write lowers the ceiling', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'flujo-hotspots-'));
  try {
    mkdirSync(path.join(cwd, 'scripts'));
    mkdirSync(path.join(cwd, 'src'));
    writeFileSync(path.join(cwd, 'src', 'a.ts'), 'one\ntwo\n');
    const contract = path.join(cwd, CONTRACT_FILE);
    writeFileSync(contract, JSON.stringify({ hotspots: [{ file: 'src/a.ts', maxLines: 3 }] }));
    const env = { HOTSPOT_BASE: 'no-such-commit' };
    const errors = [];
    assert.equal(run({ cwd, env, argv: [], log: () => {}, error: (line) => errors.push(line) }), 1);
    assert.match(errors.join('\n'), /src\/a\.ts {2}3 -> 2/);
    assert.equal(run({ cwd, env, argv: ['--write'], log: () => {}, error: () => {} }), 0);
    assert.equal(JSON.parse(readFileSync(contract, 'utf8')).hotspots[0].maxLines, 2);
    writeFileSync(path.join(cwd, 'src', 'a.ts'), 'one\ntwo\nthree\n');
    assert.equal(run({ cwd, env, argv: ['--write'], log: () => {}, error: () => {} }), 1);
    assert.equal(JSON.parse(readFileSync(contract, 'utf8')).hotspots[0].maxLines, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('every split module must be named in the architecture guide', () => {
  const listed = [{ file: 'src/big.ts', maxLines: 9, modules: ['src/split/one.ts', 'src/split/two.ts'] }];
  assert.deepEqual(findUndocumentedModules(listed, '| `one.ts` | Owns one thing |'), ['src/split/two.ts']);
  assert.deepEqual(findUndocumentedModules(listed, 'one.ts and two.ts without backticks'), ['src/split/one.ts', 'src/split/two.ts']);
  assert.deepEqual(findUndocumentedModules([{ file: 'src/big.ts', maxLines: 9 }], ''), []);
  const text = describeProblems([], [], ['src/split/two.ts']);
  assert.match(text, /src\/split\/two\.ts/);
  assert.match(text, /Add each one to the module map/);
});

test('run fails until a listed module is named in the guide', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'flujo-hotspots-'));
  try {
    mkdirSync(path.join(cwd, 'scripts'));
    mkdirSync(path.join(cwd, 'src'));
    mkdirSync(path.join(cwd, path.dirname(GUIDE)), { recursive: true });
    writeFileSync(path.join(cwd, 'src', 'a.ts'), 'one\n');
    writeFileSync(path.join(cwd, 'src', 'aPart.ts'), '// Part of a.\n');
    writeFileSync(path.join(cwd, CONTRACT_FILE), JSON.stringify({ hotspots: [{ file: 'src/a.ts', maxLines: 1, modules: ['src/aPart.ts'] }] }));
    const env = { HOTSPOT_BASE: 'no-such-commit' };
    const errors = [];
    assert.equal(run({ cwd, env, argv: [], log: () => {}, error: (line) => errors.push(line) }), 1);
    assert.match(errors.join('\n'), /src\/aPart\.ts/);
    writeFileSync(path.join(cwd, GUIDE), '| `aPart.ts` | Owns part of a |\n');
    assert.equal(run({ cwd, env, argv: [], log: () => {}, error: () => {} }), 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the guide names files by path, by folder or next to a big file, outside code blocks', () => {
  const guide = [
    'Paths: `src/x/full.ts`, `flow/aTest.test.ts`, `init.ts`, `chatGoalStore.ts` in `src/goals/`, `.ts`, `use client`.',
    '`aPart.ts` sits next to its big file. `model:dispatch` is an event, `@/utils/realpath` an alias.',
    '```sh',
    'node scripts/only-in-a-code-block.mjs `inBlock.ts`',
    '```',
  ].join('\n');
  assert.deepEqual(guideFileNames(guide), ['src/x/full.ts', 'flow/aTest.test.ts', 'init.ts', 'chatGoalStore.ts', 'aPart.ts']);
  const files = new Set(['src/x/full.ts', '__tests__/flow/aTest.test.ts', 'src/goals/chatGoalStore.ts', 'src/big/aPart.ts', 'src/backend/init.ts']);
  const listed = [{ file: 'src/big/big.ts', maxLines: 9, modules: ['src/big/aPart.ts'] }];
  assert.deepEqual(findMissingGuideFiles(listed, guide, (file) => files.has(file)), ['init.ts']);
  const text = describeProblems([], [], [], ['init.ts']);
  assert.match(text, /names files that do not exist/);
  assert.match(text, /path from the repository root/);
});

test('run fails while the guide names a file that does not exist', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'flujo-hotspots-'));
  try {
    mkdirSync(path.join(cwd, 'scripts'));
    mkdirSync(path.join(cwd, 'src'));
    mkdirSync(path.join(cwd, path.dirname(GUIDE)), { recursive: true });
    writeFileSync(path.join(cwd, 'src', 'a.ts'), 'one\n');
    writeFileSync(path.join(cwd, CONTRACT_FILE), JSON.stringify({ hotspots: [{ file: 'src/a.ts', maxLines: 1 }] }));
    writeFileSync(path.join(cwd, GUIDE), 'The run lives in `a.ts`; recovery in `gone.ts`.\n');
    const env = { HOTSPOT_BASE: 'no-such-commit' };
    const errors = [];
    assert.equal(run({ cwd, env, argv: [], log: () => {}, error: (line) => errors.push(line) }), 1);
    assert.match(errors.join('\n'), /gone\.ts/);
    writeFileSync(path.join(cwd, GUIDE), 'The run lives in `a.ts`.\n');
    assert.equal(run({ cwd, env, argv: [], log: () => {}, error: () => {} }), 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
