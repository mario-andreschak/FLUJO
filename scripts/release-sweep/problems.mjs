// Turns a sweep report into distinct problems, each with a fingerprint that stays the same from one
// run to the next, so the reporter files one issue per problem and finds it again later. Failures the
// sweep machine caused (disk, memory, network, its own browser) are never problems: they are listed
// apart and retried, because they say nothing about FLUJO.
import { createHash } from 'node:crypto';

/** Strips what changes between runs (hosts, ports, ids, build hashes, numbers) from an error's first line. */
export function normalizeError(message) {
  return String(message ?? '')
    .split('\n')[0]
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/https?:\/\/[^\s"'<>)]+/g, (url) => {
      try {
        const { pathname, search } = new URL(url);
        return `${pathname}${search ? '?…' : ''}`;
      } catch {
        return '<url>';
      }
    })
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/(?<![a-z0-9])(?=[a-z0-9]*\d[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}(?![a-z0-9])/gi, '<hash>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * The part of an error that names the problem, for fingerprints only: on top of normalizeError it folds
 * the one- and two-letter names a production build gives local variables, which change with every release.
 */
export function errorKey(message) {
  return normalizeError(message).replace(/(^|[\s'"(:])[A-Za-z_$][\w$]?(?=\.[A-Za-z_$]|\s+is\s|['"])/g, '$1<min>');
}

/** A coarse reason that survives small wording changes: the same check failing the same way is one problem. */
export function errorCategory(message) {
  const text = String(message ?? '');
  if (/took longer than/i.test(text)) return 'too slow';
  if (/FLUJO shows instead of the page/i.test(text)) return 'error screen';
  if (/stayed on its loading screen/i.test(text)) return 'stuck loading';
  if (/did not appear on the page/i.test(text)) return 'text missing';
  if (/Timeout \d+ms exceeded|waiting for/i.test(text)) return 'element missing';
  return normalizeError(text);
}

const categoryKey = (message) => {
  const category = errorCategory(message);
  return category === normalizeError(message) ? errorKey(message) : category;
};

/**
 * Failures the sweep machine caused rather than FLUJO. Only messages the sweep itself produces are read here
 * (npm's install log, Playwright, the file system), so FLUJO running out of its own heap still counts as FLUJO.
 */
const RUNNER_CAUSES = [
  [/\bENOSPC\b|no space left on device/i, 'the sweep machine ran out of disk space'],
  [/\bENOMEM\b|cannot allocate memory/i, 'the sweep machine ran out of memory'],
  [/\bEMFILE\b|too many open files/i, 'the sweep machine ran out of file handles'],
  [/browser has been closed|\bbrowser closed\b|browserType\.launch|Executable doesn't exist|Host system is missing dependencies|Cannot find (?:module|package) 'playwright'/i,
    "the sweep's browser stopped or would not start"],
  [/No matching version found for flujo-ai@|'flujo-ai@[^']*' is not in this registry|404 Not Found - GET https:\/\/registry\.npmjs\.org\/flujo-ai(?![\w-])|npm installed flujo-ai \S+, not /i,
    'the release had not reached the npm registry yet'],
  [/npm (?:ERR!|error) (?:code )?(?:ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ERR_SOCKET_TIMEOUT|E5\d\d)\b|npm (?:ERR!|error) network|npm-cli\.js took longer than/i,
    'npm could not reach the registry'],
  [/Could not find npm beside Node/i, 'the sweep machine has no npm beside Node'],
];

/** Why the sweep machine, not FLUJO, caused this failure; undefined when FLUJO may be at fault. */
export function runnerCause(message) {
  const text = String(message ?? '');
  return RUNNER_CAUSES.find(([pattern]) => pattern.test(text))?.[1];
}

export function stepSignature(step = {}) {
  const target = step.name ?? step.label ?? step.text ?? step.route ?? step.key ?? '';
  return [step.do, step.role, `"${target}"`].filter(Boolean).join(' ');
}

export function fingerprint(parts) {
  return `rs-${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12)}`;
}

function checkSummary(check) {
  return {
    id: check.id, entry: check.entry, file: check.file, entryTitle: check.entryTitle, label: check.label,
    failedStep: check.failedStep, error: check.error, url: check.url, evidence: check.evidence, ariaExcerpt: check.ariaExcerpt,
    confirmed: check.confirmed, retryError: check.retryError,
  };
}

/** What the sweep machine got wrong in this report: never filed, listed in the run summary and retried next release. */
export function runnerNotes(report) {
  const notes = [];
  if (report.result === 'runner' || (report.result === 'broken' && runnerCause(report.brokenReason))) {
    notes.push({ where: 'the whole sweep', cause: report.runnerCause ?? runnerCause(report.brokenReason) ?? 'the sweep machine failed', error: String(report.brokenReason ?? '').split('\n')[0] });
  }
  const instanceCause = runnerCause(report.instanceProblem);
  if (instanceCause) notes.push({ where: 'the rest of the sweep (FLUJO stopped answering right after)', cause: instanceCause, error: String(report.instanceProblem).split('\n')[0] });
  for (const check of (report.entries ?? []).flatMap((entry) => entry.checks ?? [])) {
    const cause = check.status === 'runner' ? check.reason : check.status === 'failed' ? runnerCause(check.error) : undefined;
    if (cause) notes.push({ where: `${check.entryTitle} › ${check.label} (\`${check.id}\`)`, cause, error: String(check.error ?? '').split('\n')[0] });
  }
  return notes;
}

/**
 * @param {object} report the report.json a sweep wrote
 * @returns {{ fingerprint: string, kind: 'broken'|'instance'|'step'|'page-error', title: string, error: string, checks: object[] }[]}
 */
export function problemsFromReport(report) {
  const problems = new Map();
  const add = (parts, make, check) => {
    const id = fingerprint(parts);
    if (!problems.has(id)) problems.set(id, { fingerprint: id, ...make(), checks: [] });
    if (check) problems.get(id).checks.push(checkSummary(check));
  };
  if (report.result === 'runner') return [];
  if (report.result === 'broken' && !runnerCause(report.brokenReason)) {
    add(['broken', categoryKey(report.brokenReason)], () => ({
      kind: 'broken', title: 'Release sweep could not run', error: String(report.brokenReason ?? 'unknown reason').split('\n')[0],
    }));
  }
  if (report.instanceProblem && !runnerCause(report.instanceProblem)) {
    add(['instance'], () => ({
      kind: 'instance', title: 'Release sweep: FLUJO stopped answering during the sweep', error: report.instanceProblem.split('\n')[0],
    }));
  }
  for (const entry of report.entries ?? []) {
    for (const check of entry.checks ?? []) {
      if (check.status === 'failed' && !runnerCause(check.error)) {
        const category = errorCategory(check.error);
        add(['step', check.id, stepSignature(check.failedStep?.step), categoryKey(check.error)], () => ({
          kind: 'step', title: `Release sweep: ${check.entryTitle} › ${check.label} fails (${category.slice(0, 60)})`,
          error: String(check.error ?? '').split('\n')[0],
        }), check);
      }
      const seen = new Set();
      for (const raw of check.pageErrors ?? []) {
        const key = errorKey(raw);
        if (seen.has(key)) continue;
        seen.add(key);
        const message = normalizeError(raw);
        add(['page-error', key], () => ({
          kind: 'page-error', title: `Release sweep: page error "${message.slice(0, 80)}"`, error: message,
        }), check);
      }
    }
  }
  return [...problems.values()];
}
