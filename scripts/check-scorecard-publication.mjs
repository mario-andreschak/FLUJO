import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const planningSource = '3511ba49514fe8cf525f5a22c16c3806bf3886ba';
const requiredGuides = [
  'README.md', 'docs/project-status.md', 'CHANGELOG.md', 'SECURITY.md',
  'docs/architecture/README.md', 'docs/api-reference/README.md',
  'docs/features/workspaces.md', 'docs/features/mcp/overview.md',
  'docs/features/hot-clone-workspace.md', 'src/utils/encryption/README.md',
  'docs/npm-release.md', 'docs/windows-installer-release-checklist.md',
];

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], { maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function commit(repository, source) {
  if (!/^[0-9a-f]{40}$/.test(source ?? '')) throw new Error('An exact 40-character commit SHA is required');
  const actual = git(repository, ['rev-parse', '--verify', '--end-of-options', source + '^{commit}']).toString().trim();
  if (actual !== source) throw new Error('Commit identity mismatch');
  return actual;
}

/** Extract ordinary inline targets and reference definitions outside fenced code. */
function markdownTargets(source) {
  let fence = null;
  const lines = source.split(/\r?\n/).map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = match?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && !match[2].trim()) fence = null;
      return '';
    }
    if (marker && (marker[0] !== '`' || !match[2].includes('`'))) { fence = marker; return ''; }
    return line.replace(/(`+)[^`]*?\1/g, '');
  });
  const text = lines.join('\n');
  const targets = [];
  function targetAt(start) {
    while (/\s/.test(text[start] ?? '') && start < text.length) start++;
    if (text[start] === '<') {
      const end = text.indexOf('>', start + 1);
      return end < 0 ? null : text.slice(start + 1, end);
    }
    let target = '', nested = 0;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (char === '\\' && i + 1 < text.length) { target += text[++i]; continue; }
      if (/\s/.test(char)) break;
      if (char === '(') nested++;
      if (char === ')') { if (!nested) break; nested--; }
      target += char;
    }
    return target || null;
  }
  for (let cursor = 0; (cursor = text.indexOf('](', cursor)) >= 0; cursor += 2) {
    const target = targetAt(cursor + 2);
    if (target) targets.push(target);
  }
  const definitions = /^ {0,3}\[[^\]\r\n]+\]:[ \t]*/gm;
  for (const match of text.matchAll(definitions)) {
    const target = targetAt(match.index + match[0].length);
    if (target) targets.push(target);
  }
  return [...new Set(targets)];
}

export function checkPublication({ sourceSha, baselineSha = planningSource, repository = repositoryRoot }) {
  sourceSha = commit(repository, sourceSha);
  baselineSha = commit(repository, baselineSha);
  const treeSha = git(repository, ['rev-parse', sourceSha + '^{tree}']).toString().trim();
  const entries = new Map(git(repository, ['ls-tree', '-rz', '--full-tree', sourceSha]).toString('utf8').split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t');
    const [mode, type, oid] = row.slice(0, tab).split(' ');
    return [row.slice(tab + 1), { mode, type, oid }];
  }));
  const changed = git(repository, ['diff', '--no-renames', '--name-only', '-z', baselineSha, sourceSha, '--', 'docs']).toString().split('\0').filter(file => file.endsWith('.md'));
  const guides = [...new Set([...requiredGuides, ...changed])].sort();
  const failures = [];
  function localTarget(from, target) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return { target, result: 'external-not-checked' };
    if (target.startsWith('#')) return { target, result: 'anchor-not-checked' };
    if (target.startsWith('/')) return { target, result: 'root-relative-runtime-or-host-link-not-checked' };
    const encoded = target.split(/[?#]/, 1)[0];
    let decoded;
    try { decoded = decodeURIComponent(encoded); } catch { return { target, result: 'invalid-encoding' }; }
    if (!decoded || decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return { target, result: 'invalid-path' };
    const path = posix.normalize(posix.join(posix.dirname(from), decoded));
    if (path === '..' || path.startsWith('../')) return { target, resolvedPath: path, result: 'escapes-repository' };
    const entry = entries.get(path);
    if (entry?.mode === '120000') return { target, resolvedPath: path, result: 'symlink-not-checked' };
    if (entry?.type === 'blob') return { target, resolvedPath: path, result: 'file-present', fragmentChecked: false };
    if ([...entries.keys()].some(file => file.startsWith(path.replace(/\/$/, '') + '/'))) return { target, resolvedPath: path, result: 'directory-present', fragmentChecked: false };
    return { target, resolvedPath: path, result: 'missing' };
  }
  const documents = guides.map(file => {
    const entry = entries.get(file);
    if (!entry && !requiredGuides.includes(file)) return { file, present: false, result: 'removed-since-baseline-review-required' };
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      failures.push({ file, result: entry ? 'guide-is-not-regular-file' : 'guide-missing' });
      return { file, present: false, gitMode: entry?.mode ?? null };
    }
    const size = Number(git(repository, ['cat-file', '-s', entry.oid]).toString());
    if (!Number.isSafeInteger(size) || size > 5 * 1024 * 1024) throw new Error('Guide exceeds 5 MiB: ' + file);
    const bytes = git(repository, ['cat-file', 'blob', entry.oid]);
    const links = markdownTargets(bytes.toString('utf8')).map(target => localTarget(file, target));
    for (const link of links) if (['missing', 'invalid-encoding', 'invalid-path', 'escapes-repository', 'symlink-not-checked'].includes(link.result)) failures.push({ file, ...link });
    return { file, present: true, gitBlob: entry.oid, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), links };
  });
  return {
    schemaVersion: 1, sourceSha, sourceTreeSha: treeSha, baselineSha,
    selection: { requiredGuides, additionalScope: 'All added, changed or deleted Markdown under docs since the planning baseline; deleted nonmandatory guides are recorded for review.', guideCount: guides.length },
    result: failures.length ? 'file-target-check-failed' : 'file-target-check-passed',
    documents, failures,
    limitations: [
      'Reads immutable Git objects, including their original bytes; checkout edits and line-ending conversion are excluded.',
      'Discovery covers the twelve named required guides plus changed Markdown under docs since the planning baseline; other directories and file extensions are outside automatic discovery.',
      'Checks ordinary inline Markdown targets and reference definitions outside fenced and inline code. HTML links and arbitrary Markdown extensions are not parsed.',
      'Records removed nonmandatory guides for manual claim reconciliation; mandatory guide absence or a surviving link to a removed file fails the file-target check.',
      'Anchor existence, remote links, root-relative host/runtime routes, rendering and documented behavior are not verified.',
      'Source inventory and file-target correspondence only; no installed-release, human, security or scorecard grade acceptance.'
    ]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    const names = { '--source': 'sourceSha', '--baseline': 'baselineSha', '--repository': 'repository' };
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = names[process.argv[i]];
      if (!key || !process.argv[i + 1] || Object.hasOwn(options, key)) throw new Error('Expected unique --source, --baseline or --repository options with values');
      options[key] = process.argv[i + 1];
    }
    const report = checkPublication(options);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.failures.length ? 2 : 0;
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
