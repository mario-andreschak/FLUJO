import {
  DIAGNOSTIC_REPORT_DAYS,
  diagnosticTally,
  normalizeDiagnosticReport,
  type DiagnosticReport,
} from '@/shared/types/diagnosticReport';

/** What the report is counted from. A missing section means it could not be read. */
export interface DiagnosticSources {
  now: Date;
  app: { version: unknown; installMode: unknown };
  system: { platform: string; arch: string; nodeVersion: string; cpuCores: number; totalMemoryBytes: number };
  security?: { exposureMode: unknown; ownerLogin: boolean; protection: unknown };
  models?: ReadonlyArray<{ provider?: unknown }>;
  apps?: ReadonlyArray<{ transport?: unknown; disabled?: unknown; state?: unknown }>;
  flows?: ReadonlyArray<{ nodes?: ReadonlyArray<{ type?: unknown }> }>;
  automations?: ReadonlyArray<{ enabled?: unknown; triggerType?: unknown; lastRunStatus?: unknown }>;
  activity?: {
    from: string;
    to: string;
    summary: Partial<Record<'runs' | 'successes' | 'errors' | 'cancelled' | 'runsIncomplete' | 'toolCalls'
      | 'toolFailures' | 'providerAttempts' | 'providerErrors', number>> & { errorClasses?: Record<string, number> };
    daily: ReadonlyArray<{ summary: { runs: number } }>;
  };
}

const OS: Readonly<Record<string, string>> = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const PROTECTION: Readonly<Record<string, string>> = {
  passphrase: 'passphrase',
  'operator-file': 'operator-file',
  'os-store': 'system-key',
  'legacy-default': 'default-password',
  uninitialized: 'not-set-up',
  'migration-pending': 'migration-pending',
};

function lookup(table: Readonly<Record<string, string>>, key: unknown): string | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Counts the sources into a report. Only counts and fixed labels survive. */
export function buildDiagnosticReport(sources: DiagnosticSources): DiagnosticReport {
  const { now, app, system, security, models, apps, flows, automations, activity } = sources;
  return normalizeDiagnosticReport({
    createdAt: now.toISOString(),
    app,
    system: {
      os: lookup(OS, system.platform) ?? system.platform,
      arch: system.arch,
      nodeVersion: system.nodeVersion,
      cpuCores: system.cpuCores,
      memoryGb: Math.round(system.totalMemoryBytes / 2 ** 30),
    },
    security: security && {
      networkAccess: security.exposureMode,
      ownerLogin: security.ownerLogin,
      credentialProtection: lookup(PROTECTION, security.protection) ?? security.protection,
    },
    aiConnections: models && {
      total: models.length,
      byProvider: diagnosticTally('provider', models.map(model => model.provider)),
    },
    apps: apps && {
      total: apps.length,
      enabled: apps.filter(entry => entry.disabled !== true).length,
      byTransport: diagnosticTally('transport', apps.map(entry => entry.transport)),
      byState: diagnosticTally('appState', apps.map(entry => entry.disabled === true ? 'disabled' : entry.state)),
    },
    agents: flows && {
      total: flows.length,
      usingApps: flows.filter(flow => flow.nodes?.some(node => node.type === 'mcp')).length,
      steps: flows.reduce((sum, flow) => sum + (flow.nodes?.length ?? 0), 0),
    },
    automations: automations && {
      total: automations.length,
      enabled: automations.filter(entry => entry.enabled === true).length,
      byTrigger: diagnosticTally('trigger', automations.map(entry => entry.triggerType)),
      lastRunFailed: automations.filter(entry => entry.lastRunStatus === 'error').length,
    },
    activity: activity && {
      from: activity.from,
      to: activity.to,
      daysWithRuns: activity.daily.filter(bucket => bucket.summary.runs > 0).length,
      runs: activity.summary.runs,
      finished: activity.summary.successes,
      failed: activity.summary.errors,
      stopped: activity.summary.cancelled,
      unfinished: activity.summary.runsIncomplete,
      toolCalls: activity.summary.toolCalls,
      toolFailures: activity.summary.toolFailures,
      aiRequests: activity.summary.providerAttempts,
      aiFailures: activity.summary.providerErrors,
      errorTypes: activity.summary.errorClasses,
    },
  });
}

type Section<K extends keyof DiagnosticSources> = () => Promise<NonNullable<DiagnosticSources[K]>>;

/** How each section is read. `report.test.ts` passes fakes; the route passes `defaultSources.ts`. */
export interface DiagnosticReaders {
  now?: () => Date;
  app: () => DiagnosticSources['app'];
  system: () => DiagnosticSources['system'];
  security: Section<'security'>;
  models: Section<'models'>;
  apps: Section<'apps'>;
  flows: Section<'flows'>;
  automations: Section<'automations'>;
  activity: (range: { from: string; to: string }) => Promise<NonNullable<DiagnosticSources['activity']>>;
}

/**
 * How long one section may take. A slow or failing section is left out and named
 * under "Could not read"; nothing is remembered, so the next report tries it again.
 */
export const DIAGNOSTIC_SECTION_WAIT_MS = 5_000;

export async function readWithin<T>(read: () => Promise<T>, waitMs = DIAGNOSTIC_SECTION_WAIT_MS): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>(resolve => {
    timer = setTimeout(resolve, waitMs, undefined);
    timer.unref?.();
  });
  try {
    return await Promise.race([read(), expired]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export async function collectDiagnosticReport(readers: DiagnosticReaders): Promise<DiagnosticReport> {
  const now = readers.now?.() ?? new Date();
  const range = {
    from: utcDay(now.getTime() - (DIAGNOSTIC_REPORT_DAYS - 1) * 86_400_000),
    to: utcDay(now.getTime()),
  };
  const [security, models, apps, flows, automations, activity] = await Promise.all([
    readWithin(readers.security),
    readWithin(readers.models),
    readWithin(readers.apps),
    readWithin(readers.flows),
    readWithin(readers.automations),
    readWithin(() => readers.activity(range)),
  ]);
  return buildDiagnosticReport({
    now, app: readers.app(), system: readers.system(), security, models, apps, flows, automations, activity,
  });
}
