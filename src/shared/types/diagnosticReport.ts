/**
 * The diagnostic report a person creates on their own computer and may choose to
 * share, for example with the pilot owner (#577). FLUJO never sends it.
 *
 * It holds versions, counts and labels from fixed lists only. There is no field
 * for a name, text, path, address, identifier or key, and `normalizeDiagnosticReport`
 * rebuilds every report from these lists, so such values cannot reach it.
 */
import { PROVIDER_INFO } from './model/provider';
import type { StatisticsErrorClass } from './statistics';
import type { TriggerType } from './plannedExecution/plannedExecution';

export const DIAGNOSTIC_REPORT_VERSION = 1 as const;
/** The activity section covers today and the six days before it (UTC). */
export const DIAGNOSTIC_REPORT_DAYS = 7;

const ERROR_TYPES = [
  'authentication', 'authorization', 'cancelled', 'configuration', 'context_limit',
  'network', 'provider', 'rate_limit', 'timeout', 'validation', 'unknown',
] as const satisfies readonly StatisticsErrorClass[];

const TRIGGERS = [
  'schedule', 'webhook', 'file-watch', 'mcp-poll', 'mcp-event', 'url-watch', 'flow-event',
] as const satisfies readonly TriggerType[];

/** Every label a report may contain. Anything else becomes `other`. */
export const DIAGNOSTIC_LABELS = {
  installMode: ['git', 'npm', 'container'],
  os: ['windows', 'macos', 'linux'],
  arch: ['x64', 'arm64', 'ia32', 'arm'],
  networkAccess: ['localhost', 'network', 'public'],
  credentialProtection: ['passphrase', 'operator-file', 'system-key', 'default-password', 'not-set-up', 'migration-pending'],
  provider: Object.keys(PROVIDER_INFO),
  transport: ['stdio', 'sse', 'streamable', 'websocket'],
  appState: [
    'connected', 'connecting', 'initialization', 'disconnected', 'disabled', 'error',
    'requires_authentication', 'requires_approval',
  ],
  trigger: TRIGGERS,
  errorType: ERROR_TYPES,
} as const satisfies Record<string, readonly string[]>;

export type DiagnosticLabelKind = keyof typeof DIAGNOSTIC_LABELS;

export const DIAGNOSTIC_SECTIONS = ['security', 'aiConnections', 'apps', 'agents', 'automations', 'activity'] as const;
export type DiagnosticSection = (typeof DIAGNOSTIC_SECTIONS)[number];

/** Label → how often it occurs. */
export type DiagnosticTally = Record<string, number>;

export interface DiagnosticReport {
  version: typeof DIAGNOSTIC_REPORT_VERSION;
  createdAt: string;
  app: { version: string; installMode: string };
  system: { os: string; arch: string; nodeVersion: string; cpuCores: number; memoryGb: number };
  security: { networkAccess: string; ownerLogin: boolean; credentialProtection: string } | null;
  aiConnections: { total: number; byProvider: DiagnosticTally } | null;
  apps: { total: number; enabled: number; byTransport: DiagnosticTally; byState: DiagnosticTally } | null;
  agents: { total: number; usingApps: number; steps: number } | null;
  automations: { total: number; enabled: number; byTrigger: DiagnosticTally; lastRunFailed: number } | null;
  activity: {
    from: string;
    to: string;
    daysWithRuns: number;
    runs: number;
    finished: number;
    failed: number;
    stopped: number;
    unfinished: number;
    toolCalls: number;
    toolFailures: number;
    aiRequests: number;
    aiFailures: number;
    errorTypes: DiagnosticTally;
  } | null;
  /** Sections that could not be read this time; creating the report again retries them. */
  unavailable: DiagnosticSection[];
}

/** `value` when it is on the list for `kind`; `unknown` when missing; otherwise `other`. */
export function diagnosticLabel(kind: DiagnosticLabelKind, value: unknown): string {
  if (value === undefined || value === null || value === '' || value === 'unknown') return 'unknown';
  const allowed: readonly string[] = DIAGNOSTIC_LABELS[kind];
  return typeof value === 'string' && allowed.includes(value) ? value : 'other';
}

export function diagnosticCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Counts each value under its allowed label, in a stable order. */
export function diagnosticTally(kind: DiagnosticLabelKind, values: Iterable<unknown>): DiagnosticTally {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = diagnosticLabel(kind, value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function tally(kind: DiagnosticLabelKind, value: unknown): DiagnosticTally {
  if (!isObject(value)) return {};
  const counts: DiagnosticTally = {};
  for (const [label, count] of Object.entries(value)) {
    const safe = diagnosticLabel(kind, label);
    const amount = diagnosticCount(count);
    if (amount > 0) counts[safe] = (counts[safe] ?? 0) + amount;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc|next|canary|dev|pre)(?:\.\d{1,6})*)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function version(value: unknown): string {
  return typeof value === 'string' && VERSION.test(value) ? value : 'unknown';
}

function day(value: unknown): string {
  return typeof value === 'string' && DAY.test(value) ? value : 'unknown';
}

function section<T>(value: unknown, read: (source: Record<string, unknown>) => T): T | null {
  return isObject(value) ? read(value) : null;
}

/**
 * Rebuilds a report from fixed fields and lists only. The server runs it before a
 * report leaves the backend and the page runs it again before showing one, so an
 * older or changed server cannot put other text into the report.
 */
export function normalizeDiagnosticReport(input: unknown): DiagnosticReport {
  const source = isObject(input) ? input : {};
  const app = isObject(source.app) ? source.app : {};
  const system = isObject(source.system) ? source.system : {};
  const report: DiagnosticReport = {
    version: DIAGNOSTIC_REPORT_VERSION,
    createdAt: typeof source.createdAt === 'string' && INSTANT.test(source.createdAt) ? source.createdAt : 'unknown',
    app: { version: version(app.version), installMode: diagnosticLabel('installMode', app.installMode) },
    system: {
      os: diagnosticLabel('os', system.os),
      arch: diagnosticLabel('arch', system.arch),
      nodeVersion: version(system.nodeVersion),
      cpuCores: diagnosticCount(system.cpuCores),
      memoryGb: diagnosticCount(system.memoryGb),
    },
    security: section(source.security, value => ({
      networkAccess: diagnosticLabel('networkAccess', value.networkAccess),
      ownerLogin: value.ownerLogin === true,
      credentialProtection: diagnosticLabel('credentialProtection', value.credentialProtection),
    })),
    aiConnections: section(source.aiConnections, value => ({
      total: diagnosticCount(value.total),
      byProvider: tally('provider', value.byProvider),
    })),
    apps: section(source.apps, value => ({
      total: diagnosticCount(value.total),
      enabled: diagnosticCount(value.enabled),
      byTransport: tally('transport', value.byTransport),
      byState: tally('appState', value.byState),
    })),
    agents: section(source.agents, value => ({
      total: diagnosticCount(value.total),
      usingApps: diagnosticCount(value.usingApps),
      steps: diagnosticCount(value.steps),
    })),
    automations: section(source.automations, value => ({
      total: diagnosticCount(value.total),
      enabled: diagnosticCount(value.enabled),
      byTrigger: tally('trigger', value.byTrigger),
      lastRunFailed: diagnosticCount(value.lastRunFailed),
    })),
    activity: section(source.activity, value => ({
      from: day(value.from),
      to: day(value.to),
      daysWithRuns: diagnosticCount(value.daysWithRuns),
      runs: diagnosticCount(value.runs),
      finished: diagnosticCount(value.finished),
      failed: diagnosticCount(value.failed),
      stopped: diagnosticCount(value.stopped),
      unfinished: diagnosticCount(value.unfinished),
      toolCalls: diagnosticCount(value.toolCalls),
      toolFailures: diagnosticCount(value.toolFailures),
      aiRequests: diagnosticCount(value.aiRequests),
      aiFailures: diagnosticCount(value.aiFailures),
      errorTypes: tally('errorType', value.errorTypes),
    })),
    unavailable: [],
  };
  report.unavailable = DIAGNOSTIC_SECTIONS.filter(name => report[name] === null);
  return report;
}

function joined(counts: DiagnosticTally): string {
  return Object.entries(counts).map(([label, count]) => `${label} ${count}`).join(', ');
}

function list(counts: DiagnosticTally): string {
  const text = joined(counts);
  return text ? ` (${text})` : '';
}

const SECTION_NAMES: Record<DiagnosticSection, string> = {
  security: 'network and login settings',
  aiConnections: 'AI connections',
  apps: 'connected apps',
  agents: 'agents',
  automations: 'automations',
  activity: 'activity',
};

/** Plain text a person can read before deciding to share it. */
export function formatDiagnosticReport(input: unknown): string {
  const report = normalizeDiagnosticReport(input);
  const { app, system, security, aiConnections, apps, agents, automations, activity } = report;
  const lines = [
    `FLUJO diagnostic report (format ${report.version})`,
    `Created: ${report.createdAt}`,
    'Holds versions, counts and error counts only: no names, text, file paths, web addresses or keys.',
    '',
    `FLUJO: ${app.version} (${app.installMode})`,
    `System: ${system.os} ${system.arch}, Node.js ${system.nodeVersion}, ${system.cpuCores} CPU cores, ${system.memoryGb} GB memory`,
  ];
  if (security) {
    lines.push(`Network access: ${security.networkAccess}; owner login: ${security.ownerLogin ? 'on' : 'off'}; `
      + `credential protection: ${security.credentialProtection}`);
  }
  lines.push('');
  if (aiConnections) lines.push(`AI connections: ${aiConnections.total}${list(aiConnections.byProvider)}`);
  if (apps) {
    lines.push(`Connected apps: ${apps.total}, ${apps.enabled} enabled${list(apps.byTransport)}`);
    lines.push(`App states: ${joined(apps.byState) || 'none'}`);
  }
  if (agents) lines.push(`Agents: ${agents.total}, ${agents.usingApps} use connected apps, ${agents.steps} steps in total`);
  if (automations) {
    lines.push(`Automations: ${automations.total}, ${automations.enabled} enabled${list(automations.byTrigger)}; `
      + `last run failed: ${automations.lastRunFailed}`);
  }
  if (activity) {
    lines.push(
      '',
      `Last ${DIAGNOSTIC_REPORT_DAYS} days (${activity.from} to ${activity.to}, UTC):`,
      `  Days with runs: ${activity.daysWithRuns}`,
      `  Runs: ${activity.runs} (finished ${activity.finished}, failed ${activity.failed}, `
        + `stopped ${activity.stopped}, unfinished ${activity.unfinished})`,
      `  Tool calls: ${activity.toolCalls} (failed ${activity.toolFailures})`,
      `  AI requests: ${activity.aiRequests} (failed ${activity.aiFailures})`,
      `  Error types: ${joined(activity.errorTypes) || 'none'}`,
    );
  }
  if (report.unavailable.length) {
    lines.push('', `Could not read: ${report.unavailable.map(name => SECTION_NAMES[name]).join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}
