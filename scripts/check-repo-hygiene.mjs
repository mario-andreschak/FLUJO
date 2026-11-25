#!/usr/bin/env node
// Enforces the "Repository hygiene" rules in AGENTS.md on tracked files.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEBT_FILE = 'scripts/repo-hygiene-debt.json';
const MEDIA = /\.(?:png|jpe?g|gif|webp|avif|webm|mp4|mov|avi|mkv)$/i;
const MEDIA_HOMES = ['docs/images/', 'githubpages/', 'public/', 'src/app/'];
const PUBLISHED = ['docs/images/', 'githubpages/'];
const TEXT = /\.(?:md|mdx|html|css|js|mjs|cjs|json|ts|tsx|yml|yaml|webmanifest|xml|txt)$/i;
const RUN_RECORD = /\.(?:log|trace|har|heapsnapshot|cpuprofile|tsbuildinfo)$|(?:^|\/)jest-results[^/]*\.json$/i;
const RUN_FOLDER = /(?:^|\/)(?:[^/]+-artifacts|test-outputs|test-results|playwright-report)\//i;
const HANDOVER = /(?:^|\/)(?:[^/]*handover[^/]*|HANDOFF[^/]*)\.md$/i;

/**
 * @param {{ path: string, blob: string }[]} files tracked files with their git blob ids
 * @param {(file: string) => boolean} isReferenced whether any page or guide mentions this media file
 * @param {{ unreferencedMedia?: string[] }} debt files that broke a rule before this check existed
 */
export function findProblems(files, isReferenced, debt = {}) {
  const problems = [];
  const known = new Set(debt.unreferencedMedia ?? []);
  const blobs = new Map();
  for (const { path: file, blob } of files) {
    if (RUN_RECORD.test(file) || RUN_FOLDER.test(file)) {
      problems.push({ file, problem: 'a run record, trace or test output. Keep those outside the repository.' });
    } else if (HANDOVER.test(file)) {
      problems.push({ file, problem: 'an agent handover. Put it in the issue or PR instead.' });
    }
    if (!MEDIA.test(file)) continue;
    if (!MEDIA_HOMES.some((home) => file.startsWith(home))) {
      problems.push({ file, problem: `media outside ${MEDIA_HOMES.join(', ')}. Proof screenshots belong outside the repository.` });
    } else if (PUBLISHED.some((home) => file.startsWith(home)) && !isReferenced(file) && !known.has(file)) {
      problems.push({ file, problem: 'media that no page or guide uses. Commit media only when a published page or guide shows it.' });
    }
    if (blobs.has(blob)) {
      problems.push({ file, problem: `an identical copy of ${blobs.get(blob)}. Reuse the existing file.` });
    } else {
      blobs.set(blob, file);
    }
  }
  for (const file of known) {
    if (!files.some((entry) => entry.path === file) || isReferenced(file)) {
      problems.push({ file, problem: `fixed, so remove it from ${DEBT_FILE}.` });
    }
  }
  return problems;
}

export function run({ cwd = process.cwd(), log = console.log, error = console.error } = {}) {
  const listing = execFileSync('git', ['ls-files', '-s', '-z'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const files = listing.split('\0').filter(Boolean).map((line) => {
    const [meta, file] = line.split('\t');
    return { path: file, blob: meta.split(' ')[1] };
  });
  const corpus = files
    .filter(({ path: file }) => TEXT.test(file) && file !== DEBT_FILE)
    .map(({ path: file }) => {
      try {
        return readFileSync(path.join(cwd, file), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  const isReferenced = (file) => corpus.includes(path.posix.basename(file));
  const debt = JSON.parse(readFileSync(path.join(cwd, DEBT_FILE), 'utf8'));
  const problems = findProblems(files, isReferenced, debt);
  if (problems.length) {
    error(['Repository hygiene (AGENTS.md) found tracked files that do not belong:', ...problems.map(({ file, problem }) => `  ${file}: ${problem}`)].join('\n'));
    return 1;
  }
  log(`Repository hygiene holds for ${files.length} tracked files.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
