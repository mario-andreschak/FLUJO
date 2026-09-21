import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assertExactPersonaAcceptanceSource, hashPersonaAcceptanceSourceDiff } from './persona-acceptance-source.mjs';
import { validatePersonaSoakArtifacts } from './validate-persona-soak-artifacts.mjs';

function removeFixture(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  assert.match(path.basename(directory), /^persona-source-/);
  rmSync(directory, { recursive: true, force: true });
}

test('exact-commit acceptance rejects changed, staged, untracked, and different-commit sources', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'persona-source-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init');
    writeFileSync(path.join(cwd, 'source.txt'), 'original');
    writeFileSync(path.join(cwd, '.gitignore'), 'artifact.json\n');
    git('add', '.');
    git('-c', 'user.name=Persona test', '-c', 'user.email=persona@example.test', 'commit', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    assert.doesNotThrow(() => assertExactPersonaAcceptanceSource(commit, cwd));
    writeFileSync(path.join(cwd, 'artifact.json'), '{}');
    assert.doesNotThrow(() => assertExactPersonaAcceptanceSource(commit, cwd));
    writeFileSync(path.join(cwd, 'source.txt'), 'edited');
    assert.throws(() => assertExactPersonaAcceptanceSource(commit, cwd), /clean checkout/);
    git('add', 'source.txt');
    assert.throws(() => assertExactPersonaAcceptanceSource(commit, cwd), /clean checkout/);
    git('-c', 'user.name=Persona test', '-c', 'user.email=persona@example.test', 'commit', '-m', 'changed');
    assert.throws(() => assertExactPersonaAcceptanceSource(commit, cwd), /commit changed/);
    const next = git('rev-parse', 'HEAD');
    writeFileSync(path.join(cwd, 'new-source.ts'), 'export {};');
    assert.throws(() => assertExactPersonaAcceptanceSource(next, cwd), /clean checkout/);
  } finally {
    removeFixture(cwd);
  }
});

test('standalone validation rejects artifacts invalidated by a source change', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'persona-source-artifacts-'));
  try {
    writeFileSync(path.join(directory, 'persona-soak-source-error.json'), '{}');
    await assert.rejects(validatePersonaSoakArtifacts({ directory, expectedCommit: 'a'.repeat(40), expectedMode: 'acceptance' }), /source verification failed/);
  } finally {
    removeFixture(directory);
  }
});

test('diagnostic identity streams a diff beyond 1 MiB and includes untracked source paths verbatim', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'persona-source-large-'));
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init');
    writeFileSync(path.join(cwd, 'source.txt'), 'original\n');
    git('add', '.');
    git('-c', 'user.name=Persona test', '-c', 'user.email=persona@example.test', 'commit', '-m', 'fixture');
    writeFileSync(path.join(cwd, 'source.txt'), 'changed\n' + 'x'.repeat(1200000) + '\n');
    mkdirSync(path.join(cwd, 'src'));
    const name = 'src/Unicode ä and spaces.ts';
    writeFileSync(path.join(cwd, name), 'export const value = 42;\n');
    writeFileSync(path.join(cwd, 'notes.txt'), 'Untracked non-source notes are outside the diagnostic source scope.');
    const diff = git('-c', 'core.safecrlf=false', 'diff', '--binary', 'HEAD');
    assert.ok(diff.length > 1024 * 1024);
    const expected = createHash('sha256').update(diff).update(name).update(readFileSync(path.join(cwd, name))).digest('hex');
    assert.equal(await hashPersonaAcceptanceSourceDiff(cwd), expected);
    git('add', 'source.txt');
    assert.equal(await hashPersonaAcceptanceSourceDiff(cwd), expected, 'staging changes must preserve the same HEAD-to-tree identity');
    writeFileSync(path.join(cwd, name), 'export const value = 43;\n');
    assert.notEqual(await hashPersonaAcceptanceSourceDiff(cwd), expected);
  } finally {
    removeFixture(cwd);
  }
});

test('diagnostic identity rejects a failed git command instead of returning a partial hash', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'persona-source-invalid-'));
  try {
    await assert.rejects(hashPersonaAcceptanceSourceDiff(cwd), /fingerprint failed/);
  } finally {
    removeFixture(cwd);
  }
});
