import type { MCPStdioConfig } from '@/shared/types/mcp';
import path from 'node:path';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';
import {
  createShippedServerConfig,
  SHIPPED_MCP_SERVERS,
  type ShippedMcpServerDescriptor,
} from './shippedServers';

const log = createLogger('backend/services/mcp/shippedServerMigration');

// Keyed by workspace (#406): shipped-server provisioning writes workspace-owned
// storage markers, so workspace B must not be short-circuited by — or wait on —
// a run that is provisioning workspace A.
const migrationsInFlight = new Map<string, Promise<void>>();

type LegacyServerOverride = {
  disabled?: boolean;
  roots?: string[];
  exposeAsMcpServer?: boolean;
  enableMcpApps?: boolean;
};
type LegacyServerOverrides = Record<string, LegacyServerOverride>;
type StoredServer = Record<string, unknown>;
type StoredServers = Record<string, StoredServer>;

function applyLegacyOverride(
  stored: StoredServer,
  override?: LegacyServerOverride,
): StoredServer {
  const next = { ...stored };
  for (const key of ['disabled', 'exposeAsMcpServer', 'enableMcpApps'] as const) {
    if (typeof override?.[key] === 'boolean') next[key] = override[key];
  }
  if (Array.isArray(override?.roots)) next.roots = [...override.roots];
  return next;
}

function persistedConfig(
  config: MCPStdioConfig,
  override?: LegacyServerOverride,
): StoredServer {
  return applyLegacyOverride(
    Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'name')),
    override,
  );
}

function marketplacePackageId(stored: StoredServer): string | undefined {
  const source = stored.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  return record.type === 'marketplace' && typeof record.id === 'string'
    ? record.id
    : undefined;
}

function descriptorPackageIds(descriptor: ShippedMcpServerDescriptor): readonly string[] {
  return [descriptor.packageId, ...(descriptor.legacyPackageIds ?? [])];
}

function isInstalledPackage(stored: StoredServer, descriptor: ShippedMcpServerDescriptor): boolean {
  const sourceId = marketplacePackageId(stored);
  return descriptorPackageIds(descriptor).some((packageId) =>
    sourceId === packageId || stored.internalPackage === packageId
  );
}

function hasInstalledPackage(
  servers: StoredServers,
  descriptor: ShippedMcpServerDescriptor,
): boolean {
  return Object.values(servers).some((stored) =>
    isLegacyShippedRecord(stored, descriptor)
  );
}

/**
 * Seed records only when the default name is free and that package is not already
 * present under a renamed key. A user-owned same-name record always wins.
 */
async function runLegacySeedMigration(): Promise<void> {
  const completed = await loadItem<boolean>(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, false);
  if (completed === true) return;

  const loaded = await loadItem<StoredServers>(StorageKey.MCP_SERVERS, {});
  const overrides = await loadItem<LegacyServerOverrides>(StorageKey.MCP_INTERNAL_OVERRIDES, {});
  const nextServers = { ...(loaded && typeof loaded === 'object' ? loaded : {}) };

  for (const descriptor of SHIPPED_MCP_SERVERS) {
    if (Object.prototype.hasOwnProperty.call(nextServers, descriptor.defaultName)) {
      const stored = nextServers[descriptor.defaultName];
      // A retry after a marker-write failure sees the record written by the first
      // attempt. Reapply its restored override, while never touching a user-owned
      // collision that merely shares the default name.
      if (isLegacyShippedRecord(stored, descriptor)) {
        nextServers[descriptor.defaultName] = applyLegacyOverride(
          stored,
          overrides?.[descriptor.defaultName],
        );
      }
      continue;
    }
    if (hasInstalledPackage(nextServers, descriptor)) continue;
    nextServers[descriptor.defaultName] = persistedConfig(
      createShippedServerConfig(descriptor),
      overrides?.[descriptor.defaultName],
    );
  }

  let overridesCleared = false;
  try {
    await saveItem(StorageKey.MCP_SERVERS, nextServers);
    await saveItem(StorageKey.MCP_INTERNAL_OVERRIDES, {});
    overridesCleared = true;
    await saveItem(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);
  } catch (error) {
    if (overridesCleared) {
      try {
        await saveItem(StorageKey.MCP_INTERNAL_OVERRIDES, overrides);
      } catch (restoreError) {
        log.error('Failed to restore MCP overrides after migration failure', restoreError);
      }
    }
    throw error;
  }
}

/** Seed browser for installations that completed V1 before that package shipped. */
async function runBrowserSeedMigration(): Promise<void> {
  const completed = await loadItem<boolean>(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3, false);
  if (completed === true) return;

  const loaded = await loadItem<StoredServers>(StorageKey.MCP_SERVERS, {});
  const nextServers = { ...(loaded && typeof loaded === 'object' ? loaded : {}) };
  const descriptor = SHIPPED_MCP_SERVERS.find((item) => item.packageDirectory === 'browser');
  if (
    descriptor
    && !Object.prototype.hasOwnProperty.call(nextServers, descriptor.defaultName)
    && !hasInstalledPackage(nextServers, descriptor)
  ) {
    nextServers[descriptor.defaultName] = persistedConfig(createShippedServerConfig(descriptor));
    await saveItem(StorageKey.MCP_SERVERS, nextServers);
  }
  await saveItem(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3, true);
}

function isLegacyShippedRecord(
  stored: StoredServer,
  descriptor: ShippedMcpServerDescriptor,
): boolean {
  if (isInstalledPackage(stored, descriptor)) return true;
  return stored.transport === 'stdio'
    && stored.command === 'npx'
    && Array.isArray(stored.args)
    && stored.args[0] === '--no-install'
    && stored.args[1] === `flujo-mcp-${descriptor.packageDirectory}`;
}

function normalizedInstalledRecord(
  stored: StoredServer,
  descriptor: ShippedMcpServerDescriptor,
): StoredServer {
  const expected = persistedConfig(createShippedServerConfig(descriptor));
  const ordinary = { ...stored };
  delete ordinary.internalPackage;
  delete ordinary.packageCapabilities;
  const storedEnv = ordinary.env && typeof ordinary.env === 'object' && !Array.isArray(ordinary.env)
    ? ordinary.env as Record<string, unknown>
    : {};
  const next: StoredServer = {
    ...ordinary,
    transport: expected.transport,
    command: expected.command,
    args: expected.args,
    cwd: expected.cwd,
    env: { ...(expected.env as Record<string, unknown>), ...storedEnv },
    source: expected.source,
    disabled: typeof ordinary.disabled === 'boolean' ? ordinary.disabled : expected.disabled,
    roots: Array.isArray(ordinary.roots) ? ordinary.roots : expected.roots,
    exposeAsMcpServer: typeof ordinary.exposeAsMcpServer === 'boolean'
      ? ordinary.exposeAsMcpServer
      : expected.exposeAsMcpServer,
    enableMcpApps: typeof ordinary.enableMcpApps === 'boolean'
      ? ordinary.enableMcpApps
      : expected.enableMcpApps,
    ...(expected.hostPathAccess ? { hostPathAccess: expected.hostPathAccess } : {}),
  };
  return next;
}

/**
 * Convert previously provisioned records to the same ordinary stdio shape used
 * for fresh installs. Package/source identity is used only by this migration, so
 * renamed records are upgraded without relying on their display name.
 */
async function runOrdinaryStdioMigration(): Promise<void> {
  const completed = await loadItem<boolean>(StorageKey.MCP_SHIPPED_SERVERS_MIGRATION_V4, false);
  if (completed === true) return;

  const loaded = await loadItem<StoredServers>(StorageKey.MCP_SERVERS, {});
  const nextServers = { ...(loaded && typeof loaded === 'object' ? loaded : {}) };
  let changed = false;

  for (const [recordName, stored] of Object.entries(nextServers)) {
    const descriptor = SHIPPED_MCP_SERVERS.find((candidate) =>
      isLegacyShippedRecord(stored, candidate)
    );
    if (!descriptor) continue;
    const normalized = normalizedInstalledRecord(stored, descriptor);
    if (JSON.stringify(normalized) !== JSON.stringify(stored)) {
      nextServers[recordName] = normalized;
      changed = true;
    }
  }

  if (changed) await saveItem(StorageKey.MCP_SERVERS, nextServers);
  await saveItem(StorageKey.MCP_SHIPPED_SERVERS_MIGRATION_V4, true);
}

/** Backfill the package directory for shipped records created with a blank server root. */
async function runShippedServerRootsMigration(): Promise<void> {
  const completed = await loadItem<boolean>(StorageKey.MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5, false);
  if (completed === true) return;

  const loaded = await loadItem<StoredServers>(StorageKey.MCP_SERVERS, {});
  const nextServers = { ...(loaded && typeof loaded === 'object' ? loaded : {}) };
  let changed = false;

  for (const [recordName, stored] of Object.entries(nextServers)) {
    const descriptor = SHIPPED_MCP_SERVERS.find((candidate) =>
      isLegacyShippedRecord(stored, candidate)
    );
    if (!descriptor || (typeof stored.rootPath === 'string' && stored.rootPath.trim())) continue;
    const expected = createShippedServerConfig(descriptor);
    nextServers[recordName] = {
      ...stored,
      args: expected.args,
      rootPath: expected.rootPath,
    };
    changed = true;
  }

  if (changed) await saveItem(StorageKey.MCP_SERVERS, nextServers);
  await saveItem(StorageKey.MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5, true);
}

/**
 * Repair browser records written under the former package id. V4/V5 could not
 * recognize those records after the package rename, so a completed migration
 * marker left their relative entrypoint and stale process error untouched.
 */
async function runBrowserRecordRepairMigration(): Promise<void> {
  const completed = await loadItem<boolean>(StorageKey.MCP_SHIPPED_BROWSER_REPAIR_MIGRATION_V6, false);
  if (completed === true) return;

  const loaded = await loadItem<StoredServers>(StorageKey.MCP_SERVERS, {});
  const nextServers = { ...(loaded && typeof loaded === 'object' ? loaded : {}) };
  const descriptor = SHIPPED_MCP_SERVERS.find((candidate) => candidate.packageDirectory === 'browser');
  let changed = false;

  if (descriptor) {
    const expected = persistedConfig(createShippedServerConfig(descriptor));
    for (const [recordName, stored] of Object.entries(nextServers)) {
      if (!isInstalledPackage(stored, descriptor)) continue;
      const repaired = normalizedInstalledRecord(stored, descriptor);
      repaired.rootPath = expected.rootPath;
      const repairedEnv = repaired.env && typeof repaired.env === 'object' && !Array.isArray(repaired.env)
        ? repaired.env as Record<string, unknown>
        : {};
      const dataDir = repairedEnv.FLUJO_DATA_DIR;
      const dataDirValue = dataDir && typeof dataDir === 'object' && !Array.isArray(dataDir) && 'value' in dataDir
        ? (dataDir as { value?: unknown }).value
        : dataDir;
      if (typeof dataDirValue === 'string' && dataDirValue.trim() && !path.isAbsolute(dataDirValue)) {
        const absoluteDataDir = path.resolve(String(expected.cwd ?? process.cwd()), dataDirValue);
        repairedEnv.FLUJO_DATA_DIR = dataDir && typeof dataDir === 'object' && !Array.isArray(dataDir)
          ? { ...dataDir, value: absoluteDataDir }
          : absoluteDataDir;
        repaired.env = repairedEnv;
      }
      for (const transient of ['error', 'path', 'status', 'stderrOutput', 'tools']) {
        delete repaired[transient];
      }
      if (JSON.stringify(repaired) !== JSON.stringify(stored)) {
        nextServers[recordName] = repaired;
        changed = true;
      }
    }
  }

  if (changed) await saveItem(StorageKey.MCP_SERVERS, nextServers);
  await saveItem(StorageKey.MCP_SHIPPED_BROWSER_REPAIR_MIGRATION_V6, true);
}

/** Provision and upgrade shipped packages without synthetic runtime injection. */
export function migrateShippedMcpServers(): Promise<void> {
  const workspace = getCurrentWorkspace();
  const existing = migrationsInFlight.get(workspace);
  if (existing) return existing;
  const migrationInFlight = (async () => {
    try {
      await runLegacySeedMigration();
      await runBrowserSeedMigration();
      await runOrdinaryStdioMigration();
      await runShippedServerRootsMigration();
      await runBrowserRecordRepairMigration();
    } finally {
      migrationsInFlight.delete(workspace);
    }
  })();
  migrationsInFlight.set(workspace, migrationInFlight);
  return migrationInFlight;
}
