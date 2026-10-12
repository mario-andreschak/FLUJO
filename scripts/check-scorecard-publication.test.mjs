import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkPublication } from './check-scorecard-publication.mjs';

const script = fileURLToPath(new URL('./check-scorecard-publication.mjs', import.meta.url));
const guides = ['README.md', 'docs/project-status.md', 'CHANGELOG.md', 'SECURITY.md',
  'docs/architecture/README.md', 'docs/api-reference/README.md', 'docs/features/workspaces.md',
  'docs/features/mcp/overview.md', 'docs/features/hot-clone-workspace.md',
  'src/utils/encryption/README.md', 'docs/npm-release.md', 'docs/windows-installer-release-checklist.md'];

function fixture(run) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'flujo-publication-'));
  const git = args => execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=' + join(directory, 'disabled-hooks'), '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const write = (file, bytes) => { fs.mkdirSync(dirname(join(directory, file)), { recursive: true }); fs.writeFileSync(join(directory, file), bytes); };
  const commit = (prepareIndex = () => {}) => { git(['add', '.']); prepareIndex(); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); };
  try {
    git(['init', '--initial-branch=main']);
    git(['config', 'core.autocrlf', 'false']);
    for (const file of guides) write(file, '# Fixture\r\n');
    const baselineSha = commit();
    run({ directory, git, write, commit, baselineSha });
  } finally {
    const cleanupPath = fs.realpathSync(directory);
    assert.equal(fs.realpathSync(dirname(cleanupPath)), fs.realpathSync(tmpdir()));
    assert.ok(basename(cleanupPath).startsWith('flujo-publication-'));
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
}

test('inventory is bound to committed bytes despite dirty checkout edits', () => {
  fixture(({ directory, write, commit, baselineSha }) => {
    const bytes = Buffer.from('# Committed\r\n[workspaces](docs/features/workspaces.md)\r\n');
    write('README.md', bytes);
    const sourceSha = commit();
    write('README.md', '[dirty missing link](does-not-exist.md)');
    const report = checkPublication({ repository: directory, sourceSha, baselineSha });
    const document = report.documents.find(d => d.file === 'README.md');
    assert.equal(report.sourceSha, sourceSha);
    assert.equal(document.byteLength, bytes.length);
    assert.equal(document.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(report.failures, []);
  });
});

test('new topic guides, references, encoded filenames and nested image links are checked', () => {
  fixture(({ directory, write, commit, baselineSha }) => {
    write('docs/new-guide.md', '# New\n[reference][target]\n[target]: <space file(1).md>\n[![image](../asset.svg)](space%20file(1).md)\n```md\n[example](not-real.md)\n```not a closing fence\n[still example](also-not-real.md)\n```\n');
    write('docs/space file(1).md', '# Target\n');
    write('asset.svg', '<svg/>');
    const sourceSha = commit();
    const report = checkPublication({ repository: directory, sourceSha, baselineSha });
    assert.ok(report.documents.some(d => d.file === 'docs/new-guide.md'));
    assert.deepEqual(report.failures, []);
    const links = report.documents.find(d => d.file === 'docs/new-guide.md').links;
    assert.ok(links.some(l => l.resolvedPath === 'docs/space file(1).md'));
    assert.ok(links.some(l => l.resolvedPath === 'asset.svg'));
    assert.ok(!links.some(l => ['not-real.md', 'also-not-real.md'].includes(l.target)));
  });
});

test('missing guides, outside paths and symlink targets cannot pass the file check', () => {
  fixture(({ directory, git, write, commit, baselineSha }) => {
    write('README.md', '[missing](missing.md)\n[outside](../outside.md)\n[symlink](link.md)\n[encoded absolute](%2FREADME.md)\n');
    fs.unlinkSync(join(directory, 'SECURITY.md'));
    write('link.md', '../outside.md');
    const oid = git(['hash-object', '-w', 'link.md']);
    const sourceSha = commit(() => git(['update-index', '--add', '--cacheinfo', '120000,' + oid + ',link.md']));
    const report = checkPublication({ repository: directory, sourceSha, baselineSha });
    for (const result of ['guide-missing', 'missing', 'escapes-repository', 'symlink-not-checked', 'invalid-path']) {
      assert.ok(report.failures.some(f => f.result === result), result);
    }
  });
});

test('removed optional guides stay visible and surviving links to them still fail', () => {
  fixture(({ directory, write, commit, baselineSha }) => {
    write('docs/retired.md', '# Old guide\n');
    const olderSha = commit();
    fs.unlinkSync(join(directory, 'docs/retired.md'));
    let sourceSha = commit();
    let report = checkPublication({ repository: directory, sourceSha, baselineSha: olderSha });
    assert.deepEqual(report.failures, []);
    assert.equal(report.documents.find(d => d.file === 'docs/retired.md').result, 'removed-since-baseline-review-required');
    write('README.md', '[old guide](docs/retired.md)');
    sourceSha = commit();
    report = checkPublication({ repository: directory, sourceSha, baselineSha: olderSha });
    assert.ok(report.failures.some(f => f.resolvedPath === 'docs/retired.md' && f.result === 'missing'));
    assert.notEqual(sourceSha, baselineSha);
  });
});

test('CLI requires exact identities and distinguishes a failed file check from malformed input', () => {
  fixture(({ directory, write, commit, baselineSha }) => {
    write('README.md', '[missing](missing.md)');
    const sourceSha = commit();
    const run = args => spawnSync(process.execPath, [script, '--repository', directory, '--baseline', baselineSha, ...args], { encoding: 'utf8' });
    const failed = run(['--source', sourceSha]);
    assert.equal(failed.status, 2, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).result, 'file-target-check-failed');
    assert.equal(run(['--source', 'HEAD']).status, 1);
    assert.equal(run(['--source', sourceSha, '--source', sourceSha]).status, 1);
    assert.throws(() => checkPublication({ repository: directory, sourceSha: '0'.repeat(40), baselineSha }));
  });
});
