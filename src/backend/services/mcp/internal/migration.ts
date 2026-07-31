import { MCPStdioConfig } from '@/shared/types/mcp';
import { Settings, StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { loadItem, saveItem } from '@/utils/storage/backend';
import {
  BROWSER_SERVER_NAME,
  builtInServerConfig,
  BUILTIN_SERVER_NAMES,
  InternalServerOverrides,
} from './registry';

const log = createLogger('backend/services/mcp/internal/migration');

let migrationInFlight: Promise<void> | undefined;

function persistedInternalConfig(
  config: MCPStdioConfig,
  override: InternalServerOverrides[string] | undefined,
): Record<string, unknown> {
  const stored = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== 'name' && key !== 'builtIn'),
  );

  if (typeof override?.disabled === 'boolean') {
    stored.disabled = override.disabled;
  }
  if (Array.isArray(override?.roots)) {
    stored.roots = [...override.roots];
  }

  return stored;
}

async function runV1Migration(): Promise<void> {
  const completed = await loadItem<boolean>(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, false);
  if (completed === true) return;

  const servers = await loadItem<Record<string, Record<string, unknown>>>(StorageKey.MCP_SERVERS, {});
  const overrides = await loadItem<InternalServerOverrides>(StorageKey.MCP_INTERNAL_OVERRIDES, {});
  const nextServers = { ...(servers && typeof servers === 'object' ? servers : {}) };

  for (const name of BUILTIN_SERVER_NAMES) {
    if (Object.prototype.hasOwnProperty.call(nextServers, name)) continue;
    nextServers[name] = persistedInternalConfig(builtInServerConfig(name), overrides?.[name]);
  }

  let overridesCleared = false;
  try {
    // Persist the ordinary records first. Legacy source data remains available if
    // this write fails, so the next startup can safely retry the migration.
    await saveItem(StorageKey.MCP_SERVERS, nextServers);

    // The ordinary records now own disabled/roots state. Clear the legacy payload,
    // then write the durable marker last so deletion stays durable on later boots.
    await saveItem(StorageKey.MCP_INTERNAL_OVERRIDES, {});
    overridesCleared = true;
    await saveItem(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);
  } catch (error) {
    // A marker-write failure must not strand an unmarked installation without its
    // source overrides. Restore them so a later call remains fully retryable.
    if (overridesCleared) {
      try {
        await saveItem(StorageKey.MCP_INTERNAL_OVERRIDES, overrides);
      } catch (restoreError) {
        log.error('Failed to restore internal MCP overrides after migration failure', restoreError);
      }
    }
    throw error;
  }

  log.info('Migrated internal MCP servers to ordinary persisted configurations');
}

function isShippedRecord(name: string, stored: Record<string, unknown>): boolean {
  const expected = builtInServerConfig(name);
  return stored.transport === expected.transport
    && stored.command === expected.command
    && stored.cwd === expected.cwd
    && JSON.stringify(stored.args ?? []) === JSON.stringify(expected.args ?? []);
}

async function runV2CapabilitiesMigration(): Promise<void> {
  const completed = await loadItem<boolean>(
    StorageKey.MCP_INTERNAL_CAPABILITIES_MIGRATION_V2,
    false,
  );
  if (completed === true) return;

  const servers = await loadItem<Record<string, Record<string, unknown>>>(StorageKey.MCP_SERVERS, {});
  const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
  const legacyProtectedPaths = settings?.experimental?.protectedPathsEnabled;
  const nextServers = { ...(servers && typeof servers === 'object' ? servers : {}) };
  let changed = false;

  for (const name of BUILTIN_SERVER_NAMES) {
    const stored = nextServers[name];
    if (!stored || !isShippedRecord(name, stored)) continue;
    const expected = builtInServerConfig(name);
    const next: Record<string, unknown> = {
      ...stored,
      internalPackage: expected.internalPackage,
      packageCapabilities: expected.packageCapabilities,
    };
    if (
      typeof legacyProtectedPaths === 'boolean'
      && expected.packageCapabilities?.hostPathAccess?.protectedPaths === true
      && typeof stored.protectedPathsEnabled !== 'boolean'
    ) {
      next.protectedPathsEnabled = legacyProtectedPaths;
    }
    nextServers[name] = next;
    changed = true;
  }

  if (changed) await saveItem(StorageKey.MCP_SERVERS, nextServers);
  await saveItem(StorageKey.MCP_INTERNAL_CAPABILITIES_MIGRATION_V2, true);
  log.info('Migrated shipped MCP package capability declarations');
}

async function runV3BrowserMigration(): Promise<void> {
  const completed = await loadItem<boolean>(
    StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3,
    false,
  );
  if (completed === true) return;

  const servers = await loadItem<Record<string, Record<string, unknown>>>(StorageKey.MCP_SERVERS, {});
  const nextServers = { ...(servers && typeof servers === 'object' ? servers : {}) };
  if (!Object.prototype.hasOwnProperty.call(nextServers, BROWSER_SERVER_NAME)) {
    nextServers[BROWSER_SERVER_NAME] = persistedInternalConfig(
      builtInServerConfig(BROWSER_SERVER_NAME),
      undefined,
    );
    await saveItem(StorageKey.MCP_SERVERS, nextServers);
  }
  await saveItem(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3, true);
  log.info('Seeded the bundled browser MCP server configuration');
}

/**
 * Idempotently migrate synthesized internal MCP servers to MCP_SERVERS records.
 * The durable marker is authoritative; this promise only coalesces concurrent
 * callers in the current process and is cleared after both success and failure.
 */
export function migrateInternalMcpServers(): Promise<void> {
  if (migrationInFlight) return migrationInFlight;

  migrationInFlight = (async () => {
    try {
      await runV1Migration();
      await runV2CapabilitiesMigration();
      await runV3BrowserMigration();
    } finally {
      migrationInFlight = undefined;
    }
  })();
  return migrationInFlight;
}
