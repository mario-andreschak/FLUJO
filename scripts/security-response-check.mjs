// Security response check (#565). Lists every open Dependabot and code
// scanning alert, compares its age with the response targets in SECURITY.md,
// and accepts an alert as handled only when docs/security/alert-triage.json
// gives a written reason that has not expired. Nothing here dismisses alerts.
//
//   node scripts/security-response-check.mjs           # live GitHub data
//   node scripts/security-response-check.mjs --json    # machine-readable result
//
// Exit code 1 means: private reporting is off, a critical or high alert is past
// its fix target without a current reason, or the triage file is invalid.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'mario-andreschak/FLUJO';
export const TRIAGE_FILE = new URL('../docs/security/alert-triage.json', import.meta.url);

/** Days after an alert or report arrives: first look (triage) and fix released. */
export const RESPONSE_TARGETS = Object.freeze({
  critical: Object.freeze({ triage: 2, fix: 7 }),
  high: Object.freeze({ triage: 7, fix: 30 }),
  medium: Object.freeze({ triage: 30, fix: 90 }),
  low: Object.freeze({ triage: 90, fix: 180 }),
});

/** How long each kind of written reason holds before someone must look again. */
export const TRIAGE_DECISIONS = Object.freeze({
  'false-positive': 180,
  'by-design': 180,
  'fixed-pending-scan': 30,
  'waiting-for-upstream': 60,
});

const SOURCES = ['dependabot', 'code-scanning'];
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function severityOf(source, alert) {
  const value = source === 'dependabot'
    ? alert.security_advisory?.severity
    : alert.rule?.security_severity_level ?? { error: 'high', warning: 'medium', note: 'low' }[alert.rule?.severity];
  return Object.hasOwn(RESPONSE_TARGETS, value) ? value : 'medium';
}

const ruleOf = (source, alert) => (source === 'dependabot' ? alert.security_advisory?.ghsa_id : alert.rule?.id);
const locationOf = (source, alert) => (source === 'dependabot'
  ? alert.dependency?.package?.name
  : alert.most_recent_instance?.location?.path);

/** Validate the written reasons. Invalid entries fail loudly instead of hiding alerts. */
export function parseTriage(document) {
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.alerts)) {
    throw new Error('alert-triage.json must have schemaVersion 1 and an alerts list.');
  }
  const seen = new Set();
  return document.alerts.map((entry, index) => {
    const where = `alert-triage.json entry ${index + 1}`;
    if (!SOURCES.includes(entry?.source) || !Number.isSafeInteger(entry.number) || entry.number < 1) {
      throw new Error(`${where} needs a source (${SOURCES.join(' or ')}) and an alert number.`);
    }
    const key = `${entry.source}#${entry.number}`;
    if (seen.has(key)) throw new Error(`${where} repeats ${key}.`);
    seen.add(key);
    if (typeof entry.rule !== 'string' || !entry.rule || typeof entry.location !== 'string' || !entry.location) {
      throw new Error(`${where} (${key}) must name the alert's rule and location so a moved alert is looked at again.`);
    }
    const maxDays = TRIAGE_DECISIONS[entry.decision];
    if (!maxDays) throw new Error(`${where} (${key}) needs a decision: ${Object.keys(TRIAGE_DECISIONS).join(', ')}.`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 40) {
      throw new Error(`${where} (${key}) needs a written reason a reviewer can check (at least 40 characters).`);
    }
    const reviewed = DATE.test(entry.reviewed ?? '') ? Date.parse(`${entry.reviewed}T00:00:00Z`) : NaN;
    const revisitBy = DATE.test(entry.revisitBy ?? '') ? Date.parse(`${entry.revisitBy}T00:00:00Z`) : NaN;
    if (!Number.isFinite(reviewed) || !Number.isFinite(revisitBy) || revisitBy < reviewed
        || revisitBy - reviewed > maxDays * DAY_MS) {
      throw new Error(`${where} (${key}) needs reviewed and revisitBy dates (YYYY-MM-DD) at most ${maxDays} days apart.`);
    }
    return { ...entry, key, revisitByMs: revisitBy };
  });
}

/**
 * Pure evaluation of the security response state. An expired or mismatched
 * reason does not block anything forever: the alert simply returns to the
 * queue and is judged by its age again.
 */
export function evaluateSecurityResponse({ now = Date.now(), privateReporting, dependabot = [], codeScanning = [], triage }) {
  const entries = parseTriage(triage);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const used = new Set();
  const rows = [];
  for (const [source, alerts] of [['dependabot', dependabot], ['code-scanning', codeScanning]]) {
    for (const alert of alerts) {
      const severity = severityOf(source, alert);
      const created = Date.parse(alert.created_at);
      const ageDays = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / DAY_MS)) : Infinity;
      const key = `${source}#${alert.number}`;
      const entry = byKey.get(key);
      if (entry) used.add(key);
      const rule = ruleOf(source, alert);
      const location = locationOf(source, alert);
      const mismatched = Boolean(entry) && (entry.rule !== rule || entry.location !== location);
      const current = Boolean(entry) && !mismatched && now < entry.revisitByMs + DAY_MS;
      const targets = RESPONSE_TARGETS[severity];
      const status = current ? 'triaged'
        : ageDays > targets.fix ? 'overdue'
          : ageDays > targets.triage ? 'needs-triage' : 'new';
      rows.push({
        key, source, number: alert.number, severity, rule, location, ageDays, status,
        ...(current ? { decision: entry.decision, revisitBy: entry.revisitBy } : {}),
        ...(entry && !current ? { expiredOrMoved: true } : {}),
      });
    }
  }
  const failures = [];
  if (privateReporting !== true) {
    failures.push('Private vulnerability reporting is off. Turn it on in the repository settings under Code security.');
  }
  for (const row of rows) {
    if (row.status === 'overdue' && (row.severity === 'critical' || row.severity === 'high')) {
      failures.push(`${row.key} (${row.severity}, ${row.rule}, ${row.location}) is ${row.ageDays} days old, past the `
        + `${RESPONSE_TARGETS[row.severity].fix}-day fix target. Fix it, or add a written reason to alert-triage.json.`);
    }
  }
  const counts = Object.fromEntries(['critical', 'high', 'medium', 'low'].map((severity) => [severity, rows.filter((row) => row.severity === severity).length]));
  const byStatus = Object.fromEntries(['triaged', 'new', 'needs-triage', 'overdue'].map((status) => [status, rows.filter((row) => row.status === status).length]));
  const stale = entries.filter((entry) => !used.has(entry.key)).map((entry) => entry.key);
  return { privateReporting: privateReporting === true, total: rows.length, counts, byStatus, rows, stale, failures };
}

function jsonLines(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/** Read live state through the GitHub CLI; `api` is replaceable for tests. */
export function collectSecurityState({ api }) {
  const reporting = JSON.parse(api(`repos/${REPOSITORY}/private-vulnerability-reporting`));
  return {
    privateReporting: reporting?.enabled === true,
    dependabot: jsonLines(api(`repos/${REPOSITORY}/dependabot/alerts?state=open&per_page=100`, true)),
    codeScanning: jsonLines(api(`repos/${REPOSITORY}/code-scanning/alerts?state=open&per_page=100`, true)),
  };
}

export function formatReport(result, now = Date.now()) {
  const lines = [
    `Security response check for ${REPOSITORY} (${new Date(now).toISOString().slice(0, 10)})`,
    `Private vulnerability reporting: ${result.privateReporting ? 'on' : 'OFF'}`,
    `Open alerts: ${result.total} (${Object.entries(result.counts).map(([severity, count]) => `${count} ${severity}`).join(', ')})`,
    `  with a current written reason: ${result.byStatus.triaged}`,
    `  new, inside the first-look target: ${result.byStatus.new}`,
    `  waiting for a first look: ${result.byStatus['needs-triage']}`,
    `  past the fix target: ${result.byStatus.overdue}`,
  ];
  const open = result.rows.filter((row) => row.status !== 'triaged');
  if (open.length) {
    lines.push('', 'Needs attention:');
    for (const row of open) {
      lines.push(`  ${row.key} ${row.severity} ${row.rule} ${row.location} - ${row.ageDays} days, ${row.status}${row.expiredOrMoved ? ' (reason expired or alert moved)' : ''}`);
    }
  }
  if (result.stale.length) {
    lines.push('', `Closed alerts still listed in alert-triage.json (remove them): ${result.stale.join(', ')}`);
  }
  if (result.failures.length) lines.push('', 'FAILED:', ...result.failures.map((failure) => `  ${failure}`));
  return lines.join('\n');
}

async function main() {
  const api = (endpoint, paginate = false) => execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--jq', '.[] | @json'] : []), endpoint], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  });
  const now = Date.now();
  const triage = JSON.parse(await readFile(TRIAGE_FILE, 'utf8'));
  const result = evaluateSecurityResponse({ now, triage, ...collectSecurityState({ api }) });
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatReport(result, now));
  if (result.failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Security response check could not run: ${error.message}`);
    process.exitCode = 1;
  });
}
