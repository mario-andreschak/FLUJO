// Turns a sweep report into distinct problems, each with a fingerprint that stays the same from one
// run to the next, so the reporter files one issue per problem and finds it again later.
import { createHash } from 'node:crypto';

/** Strips what changes between runs (hosts, ports, ids, numbers) from an error's first line. */
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
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
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
  };
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
  if (report.result === 'broken') {
    add(['broken', errorCategory(report.brokenReason)], () => ({
      kind: 'broken', title: 'Release sweep could not run', error: String(report.brokenReason ?? 'unknown reason').split('\n')[0],
    }));
  }
  if (report.instanceProblem) {
    add(['instance'], () => ({
      kind: 'instance', title: 'Release sweep: FLUJO stopped answering during the sweep', error: report.instanceProblem.split('\n')[0],
    }));
  }
  for (const entry of report.entries ?? []) {
    for (const check of entry.checks ?? []) {
      if (check.status === 'failed') {
        const category = errorCategory(check.error);
        add(['step', check.id, stepSignature(check.failedStep?.step), category], () => ({
          kind: 'step', title: `Release sweep: ${check.entryTitle} › ${check.label} fails (${category.slice(0, 60)})`,
          error: String(check.error ?? '').split('\n')[0],
        }), check);
      }
      for (const message of new Set((check.pageErrors ?? []).map(normalizeError))) {
        add(['page-error', message], () => ({
          kind: 'page-error', title: `Release sweep: page error "${message.slice(0, 80)}"`, error: message,
        }), check);
      }
    }
  }
  return [...problems.values()];
}
