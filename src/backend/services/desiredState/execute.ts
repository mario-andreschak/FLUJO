/**
 * Carries out one set of changes. Every step sets an object to a stated value, so
 * running the same set twice gives the same result. That is what lets a restart finish
 * an interrupted apply, and what lets the same code undo a failed one.
 *
 * Text that leaves this module names objects only. It never includes a stored or
 * environment value.
 */
import { flowService } from '@/backend/services/flow';
import { encryptApiKey } from '@/backend/services/model/encryption';
import { modelService } from '@/backend/services/model';
import { getSchedulerService } from '@/backend/services/scheduler';
import { ModelCatalogBusyError } from '@/backend/services/enduringAgents/runtimeLock';
import { createDefaultSettings } from '@/shared/config/defaultSettings';
import { StorageKey, type Settings } from '@/shared/types/storage';
import { isSecretEnvVar } from '@/utils/shared/common';
import { loadItem, saveItem } from '@/utils/storage/backend';
import type { ChangeSet, StoredServer } from './store';

/** A problem worth showing as it is: it names objects and never holds a value. */
export class DesiredStateWriteError extends Error {}

/** Test seam: stands in for the process dying at a named point. */
export class SimulatedCrash extends Error {}
export type CrashPoint = (point: string) => void;
let crashPoint: CrashPoint | undefined;
export function _setCrashPointForTests(hook: CrashPoint | undefined): void { crashPoint = hook; }
export function reachedPoint(point: string): void { crashPoint?.(point); }

/** A running model call holds the catalog for its length, so a write waits for it. */
const MODEL_CATALOG_WAIT_MS = 60_000;
const MODEL_CATALOG_RETRY_MS = 500;

async function writeModels(changes: ChangeSet['models']): Promise<void> {
  if (!changes.length) return;
  const deadline = Date.now() + MODEL_CATALOG_WAIT_MS;
  for (;;) {
    const result = await modelService.replaceModels(changes);
    if (result.success) return;
    const busy = (result as { code?: string }).code === new ModelCatalogBusyError().code;
    if (!busy) throw new DesiredStateWriteError(`The models could not be saved: ${result.error ?? 'unknown reason'}.`);
    if (Date.now() >= deadline) {
      throw new DesiredStateWriteError('The models could not be saved because model calls kept running for a minute. Try again when the instance is quieter.');
    }
    await new Promise((resolve) => setTimeout(resolve, MODEL_CATALOG_RETRY_MS));
  }
}

async function writeSecrets(changes: ChangeSet['secrets']): Promise<void> {
  if (!changes.length) return;
  const raw = await loadItem<Record<string, unknown>>(StorageKey.GLOBAL_ENV_VARS, {});
  const store: Record<string, unknown> = {};
  // The store is read as one format or the other, so a new entry must not leave it mixed.
  for (const [key, value] of Object.entries(raw)) {
    store[key] = typeof value === 'string'
      ? { value, metadata: { isSecret: isSecretEnvVar(key) || value.startsWith('encrypted:') || value.startsWith('encrypted_failed:') } }
      : value;
  }
  for (const change of changes) {
    if (change.fromEnv) {
      const value = process.env[change.fromEnv];
      if (value === undefined || value === '') {
        throw new DesiredStateWriteError(`The environment variable ${change.fromEnv} is not set.`);
      }
      store[change.name] = { value: await encryptApiKey(value), metadata: { isSecret: true } };
    } else if (change.stored === null || change.stored === undefined) {
      delete store[change.name];
    } else {
      store[change.name] = change.stored;
    }
  }
  await saveItem(StorageKey.GLOBAL_ENV_VARS, store);
}

async function writeSettings(changes: ChangeSet['settings']): Promise<void> {
  if (!changes.length) return;
  const stored = await loadItem<Settings | null>(StorageKey.SPEECH_SETTINGS, null);
  const document = structuredClone(stored ?? createDefaultSettings()) as unknown as Record<string, unknown>;
  for (const change of changes) {
    const [section, key] = change.path;
    const parent = (document[section] && typeof document[section] === 'object' ? document[section] : {}) as Record<string, unknown>;
    if (change.exists) parent[key] = change.value;
    else delete parent[key];
    document[section] = parent;
  }
  await saveItem(StorageKey.SPEECH_SETTINGS, document);
}

async function writeServers(changes: Array<{ name: string; value: StoredServer | null }>): Promise<void> {
  if (!changes.length) return;
  const servers = { ...await loadItem<Record<string, StoredServer>>(StorageKey.MCP_SERVERS, {}) };
  for (const change of changes) {
    if (change.value) servers[change.name] = change.value;
    else delete servers[change.name];
  }
  await saveItem(StorageKey.MCP_SERVERS, servers);
}

const SERVER_MANAGED_EXECUTION_FIELDS = ['id', 'generationId', 'createdAt', 'updatedAt'];

async function writeExecution(id: string, value: Record<string, unknown>): Promise<void> {
  const scheduler = getSchedulerService();
  const current = await scheduler.get(id) as unknown as Record<string, unknown> | null;
  const definition = Object.fromEntries(Object.entries(value).filter(([key]) => !SERVER_MANAGED_EXECUTION_FIELDS.includes(key)));
  let error: string | undefined;
  if (current) {
    // Update merges over what is there, so a field the file dropped must be cleared.
    const cleared = Object.fromEntries(Object.keys(current)
      .filter((key) => !SERVER_MANAGED_EXECUTION_FIELDS.includes(key) && !(key in definition))
      .map((key) => [key, undefined]));
    error = (await scheduler.update(id, { ...cleared, ...definition } as never)).error;
  } else {
    error = (await scheduler.create({ ...definition, id } as never)).error;
  }
  if (error) throw new DesiredStateWriteError(`Planned execution "${id}" could not be saved: ${error}`);
}

/**
 * Additions and changes go first, then removals in the opposite order, so nothing
 * points at an object that has already gone. Models come first of all because they are
 * the one write that a running conversation can hold up.
 */
export async function executeChangeSet(set: ChangeSet): Promise<void> {
  await writeSecrets(set.secrets);
  reachedPoint('secrets');
  await writeModels(set.models.filter((change) => change.value));
  reachedPoint('models');
  await writeSettings(set.settings);
  reachedPoint('settings');
  await writeServers(set.mcpServers.filter((change) => change.value));
  reachedPoint('servers');
  for (const change of set.flows) {
    if (!change.value) continue;
    const result = await flowService.saveFlow(structuredClone(change.value));
    if (!result.success) throw new DesiredStateWriteError(`Flow "${change.id}" could not be saved: ${result.error ?? 'unknown reason'}.`);
    reachedPoint(`flow:${change.id}`);
  }
  for (const change of set.plannedExecutions) {
    if (change.value) await writeExecution(change.id, change.value);
  }
  reachedPoint('planned-executions');
  for (const change of set.plannedExecutions) {
    if (!change.value) await getSchedulerService().delete(change.id);
  }
  for (const change of [...set.flows].reverse()) {
    if (change.value) continue;
    const result = await flowService.deleteFlow(change.id);
    if (!result.success) throw new DesiredStateWriteError(`Flow "${change.id}" could not be removed: ${result.error ?? 'unknown reason'}.`);
  }
  await writeServers(set.mcpServers.filter((change) => !change.value));
  await writeModels(set.models.filter((change) => !change.value));
  reachedPoint('removals');
}
