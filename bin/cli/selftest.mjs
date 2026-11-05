/**
 * `flujo selftest`: exits 0 only if the instance on this PC is really usable.
 *
 * Asks the running instance to check itself and needs no paid model call. Prints
 * nothing secret: the token stays in the environment and only reaches loopback.
 */
import { parseArgs } from 'node:util';
import { absoluteDirectory, CliError, defaultServiceRoot, report, validatePort, validateServiceName } from './common.mjs';
import { readServiceRecord } from './managed-root.mjs';

const USAGE = `Usage:
  flujo selftest [--port <port> | --name <instance>] [--workspace <name>] [--strict] [--no-network] [--json]

Exit codes: 0 usable, 1 not usable, 2 no answer from the instance.
--strict also fails when a configured model or MCP server cannot be reached.
--no-network does not try to reach models or remote MCP servers.
A login token, if this instance needs one, comes from FLUJO_OPERATIONS_TOKEN.`;

const OPTIONS = {
  port: { type: 'string' },
  name: { type: 'string' },
  root: { type: 'string' },
  workspace: { type: 'string' },
  strict: { type: 'boolean', default: false },
  'no-network': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const REQUEST_TIMEOUT_MS = 90_000;

const LABELS = { storage: 'Storage', flows: 'Flows', models: 'Models', mcp: 'MCP servers', schedules: 'Schedules' };

/** Ask the instance. Never throws; the outcome is always a result object. */
export async function askInstance({ port, workspace, token, strict = false, network = true, request = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const url = new URL(`http://127.0.0.1:${port}/api/operations/selftest`);
  if (workspace) url.searchParams.set('workspace', workspace);
  if (!network) url.searchParams.set('network', '0');
  let response;
  try {
    response = await request(url, {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      // Never send a token to a redirect target or accept a login page as an answer.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { format: 'flujo-selftest-result', usable: false, answered: false, reason: 'no-answer', checks: [] };
  }
  const refused = { format: 'flujo-selftest-result', usable: false, answered: true, checks: [] };
  if (response.status === 423) return { ...refused, reason: 'locked' };
  if (response.status === 401 || response.status === 403) return { ...refused, reason: 'needs-login' };
  if (response.status === 404) return { ...refused, reason: 'not-supported-by-this-version' };
  if (!response.ok) return { ...refused, reason: `status-${response.status}` };
  let body;
  try { body = await response.json(); }
  catch { return { ...refused, reason: 'unreadable-answer' }; }
  if (body?.format !== 'flujo-selftest' || !Array.isArray(body.checks)) return { ...refused, reason: 'unreadable-answer' };
  const failing = body.checks.filter(check => check.status === 'fail'
    || (strict && check.status === 'warn' && (check.id === 'models' || check.id === 'mcp')));
  return {
    format: 'flujo-selftest-result',
    usable: body.usable === true && failing.length === 0,
    answered: true,
    strict,
    ...(failing.length ? { reason: failing.map(check => check.id).join(',') } : {}),
    workspace: body.workspace,
    collectedAt: body.collectedAt,
    checks: body.checks,
  };
}

const REASONS = {
  'no-answer': 'The instance does not answer. Is it running on this port?',
  locked: 'The instance is locked. It needs its password, or the unlock set up in docs/operations/unattended-unlock.md.',
  'needs-login': 'The instance needs a login. Provide a token with FLUJO_OPERATIONS_TOKEN.',
  'not-supported-by-this-version': 'This version of FLUJO has no self-test.',
  'unreadable-answer': 'The instance gave an answer that could not be read.',
};

export function plainSummary(result) {
  const lines = [result.usable ? 'FLUJO is usable.' : 'FLUJO is NOT usable.'];
  if (!result.answered || !result.checks.length) lines.push(REASONS[result.reason] ?? `Reason: ${result.reason}.`);
  for (const check of result.checks) {
    const count = check.count === undefined ? '' : ` (${check.count})`;
    const reason = check.reason ? `: ${check.reason}` : '';
    lines.push(`  ${check.status.toUpperCase().padEnd(7)} ${LABELS[check.id] ?? check.id}${count}${reason}`);
    for (const item of check.items ?? []) {
      if (item.status === 'warn') lines.push(`          ${item.name}${item.host ? ` at ${item.host}` : ''}: ${item.reason}`);
    }
  }
  return lines;
}

function resolvePort(values) {
  if (values.port) return validatePort(values.port);
  if (values.name) {
    const name = validateServiceName(values.name);
    const root = values.root ? absoluteDirectory(values.root, '--root') : defaultServiceRoot(name);
    const record = readServiceRecord(root);
    if (!record) throw new CliError(`FLUJO instance "${name}" is not set up.`);
    return validatePort(record.port);
  }
  return validatePort(process.env.FLUJO_PORT || '4200');
}

export async function main(argv) {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false })); }
  catch { throw new CliError(USAGE); }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const result = await askInstance({
    port: resolvePort(values),
    workspace: values.workspace,
    token: process.env.FLUJO_OPERATIONS_TOKEN?.trim() || undefined,
    strict: values.strict,
    network: !values['no-network'],
  });
  report(result, values.json, plainSummary(result));
  if (result.usable) return 0;
  return result.answered ? 1 : 2;
}
