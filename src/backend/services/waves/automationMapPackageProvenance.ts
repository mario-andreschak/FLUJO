import type { AutomationMapPackage } from '@/shared/types/waves/automationMap';
import { StorageKey } from '@/shared/types/storage';
import { loadItem } from '@/utils/storage/backend';

interface PackageLedgerRecordLike {
  packageName?: unknown;
  version?: unknown;
  installedAt?: unknown;
  entities?: {
    flows?: unknown;
    plannedExecutions?: unknown;
  };
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))].sort();
}

/**
 * Read the narrow, non-secret entity membership needed by the Automation Map.
 * The package install ledger contains no secret values; this deliberately omits
 * model/server membership and the verbose install summary anyway.
 */
export async function loadAutomationMapPackages(): Promise<AutomationMapPackage[]> {
  const ledger = await loadItem<Record<string, PackageLedgerRecordLike>>(
    StorageKey.PACKAGE_INSTALLS,
    {},
  );
  const packages: AutomationMapPackage[] = [];

  for (const [ledgerKey, record] of Object.entries(ledger ?? {})) {
    if (!record || typeof record !== 'object') continue;
    const name = typeof record.packageName === 'string' && record.packageName
      ? record.packageName
      : ledgerKey;
    const flowMap = record.entities?.flows;
    const flowIds = flowMap && typeof flowMap === 'object' && !Array.isArray(flowMap)
      ? strings(Object.values(flowMap as Record<string, unknown>))
      : [];
    packages.push({
      name,
      ...(typeof record.version === 'string' ? { version: record.version } : {}),
      ...(typeof record.installedAt === 'string' ? { installedAt: record.installedAt } : {}),
      flowIds,
      executionIds: strings(record.entities?.plannedExecutions),
    });
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}
