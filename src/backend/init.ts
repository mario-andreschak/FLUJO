import { Cron } from 'croner';
import { verifyStorage } from '@/utils/storage/backend';
import { mcpService } from '@/backend/services/mcp';
import { sweepOldRunResources } from '@/backend/services/runResources';
import { reconcileOrphanedTasks, sweepOldSubflowTasks } from '@/backend/services/subflowTasks';
import { refreshSpotlightServers } from '@/backend/services/spotlight';
import { getSchedulerService } from '@/backend/services/scheduler';
import { isEncryptionLocked, isUserEncryptionEnabled } from '@/utils/encryption/secure';
import { createLogger } from '@/utils/logger';
import { ensureVendoredFlowGenerator } from '@/backend/services/flow/systemFlows';
import { migrateShippedMcpServers } from '@/backend/services/mcp/shippedServerMigration';
import { sweepOldMcpRemoteTasks } from '@/backend/services/mcp/remoteTaskStore';
import { resumeRemoteMcpTasks } from '@/backend/services/mcp/remoteTaskResume';
import { migrateWorkspaceLayout } from '@/backend/services/workspace/migration';
import {
  DEFAULT_WORKSPACE,
  getCurrentWorkspace,
  listWorkspaces,
  runWithWorkspace,
} from '@/utils/workspace';

const log = createLogger('backend/init');

declare global {
  // The in-flight (or settled) initialization promise. Global-backed so the
  // startup hook (instrumentation) and the /api/init route share the SAME run
  // instead of each kicking off their own server-startup sweep and racing.
  var __flujo_init_promise: Promise<void> | undefined;
  // The in-flight (or settled) secret-dependent startup promise (MCP sweep +
  // scheduler arm). Global-backed and memoized so that both the boot path
  // (runInitialization) and the unlock transition (onUnlocked) drive it exactly
  // once per process — neither double-starts servers nor double-arms triggers.
  // Deliberately NOT captured by __flujo_init_promise: while USER encryption is
  // locked this work is skipped at boot and only runs later, at unlock.
  var __flujo_secret_services_promise: Promise<void> | undefined;
  // The hourly run-resource retention sweep cron (issue #251). Global-guarded so
  // Next.js hot-reload / duplicate module instantiation can't arm it twice
  // (mirrors __flujo_run_resources / the scheduler singletons).
  var __flujo_retention_cron: Cron | undefined;
  var __flujo_subflow_task_retention_cron: Cron | undefined;
  // Hourly retention/expiry sweep for durable REMOTE MCP task records (#404).
  var __flujo_mcp_remote_task_retention_cron: Cron | undefined;
  // Workspaces (#406): per-workspace copies of the two memos above, for every
  // workspace OTHER than the default. The default workspace keeps using the
  // original globals, so existing callers and tests are untouched.
  var __flujo_workspace_init_promises: Map<string, Promise<void>> | undefined;
  var __flujo_workspace_secret_promises: Map<string, Promise<void>> | undefined;
}

// --- Per-workspace startup memos --------------------------------------------
// Startup is per workspace: each one has its own MCP servers to connect and its
// own planned executions to arm. Reading/writing the memo through these helpers
// keeps the default workspace on the original global (so
// `global.__flujo_init_promise = undefined` still resets it) while giving any
// other workspace an independent, equally memoized startup.

function getMemo(kind: 'init' | 'secret'): Promise<void> | undefined {
  const workspace = getCurrentWorkspace();
  if (workspace === DEFAULT_WORKSPACE) {
    return kind === 'init'
      ? global.__flujo_init_promise
      : global.__flujo_secret_services_promise;
  }
  const map =
    kind === 'init'
      ? global.__flujo_workspace_init_promises
      : global.__flujo_workspace_secret_promises;
  return map?.get(workspace);
}

function setMemo(kind: 'init' | 'secret', promise: Promise<void> | undefined): void {
  const workspace = getCurrentWorkspace();
  if (workspace === DEFAULT_WORKSPACE) {
    if (kind === 'init') global.__flujo_init_promise = promise;
    else global.__flujo_secret_services_promise = promise;
    return;
  }
  const map =
    kind === 'init'
      ? (global.__flujo_workspace_init_promises ??= new Map())
      : (global.__flujo_workspace_secret_promises ??= new Map());
  if (promise) map.set(workspace, promise);
  else map.delete(workspace);
}

/**
 * Arm the run-resource retention sweep (issue #251) once per process: an hourly
 * croner job that deletes spilled run resources older than the configured
 * retention age. `unref: true` keeps it from holding the Node process alive; the
 * global guard survives hot-reload. The sweep itself is a no-op when
 * retentionAgeDays <= 0, so this is safe to arm unconditionally.
 */
function armRetentionSweep(): void {
  if (!global.__flujo_retention_cron) {
    global.__flujo_retention_cron = new Cron('0 * * * *', { unref: true }, () => {
      void sweepEveryWorkspace('run-resource', () => sweepOldRunResources());
    });
    log.info('Armed run-resource retention sweep (hourly)');
  }
  if (!global.__flujo_subflow_task_retention_cron) {
    global.__flujo_subflow_task_retention_cron = new Cron('0 * * * *', { unref: true }, () => {
      void sweepEveryWorkspace('detached subflow task', () => sweepOldSubflowTasks());
    });
  }
  // Remote MCP task records (#404) are workspace-owned too: the sweep both
  // fails expired non-terminal records closed and prunes old terminal ones.
  if (!global.__flujo_mcp_remote_task_retention_cron) {
    global.__flujo_mcp_remote_task_retention_cron = new Cron('0 * * * *', { unref: true }, () => {
      void sweepEveryWorkspace('remote MCP task', () => sweepOldMcpRemoteTasks());
    });
  }
}

/**
 * Run a retention sweep once per workspace (#406).
 *
 * The crons are process-wide (armed once), but the data they prune is
 * workspace-owned, so the sweep is executed inside each workspace's context in
 * turn. One workspace's failure must not stop the others from being swept.
 */
async function sweepEveryWorkspace(label: string, sweep: () => Promise<unknown>): Promise<void> {
  let workspaces: string[];
  try {
    workspaces = (await listWorkspaces()).map(w => w.name);
  } catch (error) {
    log.warn(`Could not enumerate workspaces for the ${label} retention sweep:`, error);
    workspaces = [DEFAULT_WORKSPACE];
  }
  for (const workspace of workspaces) {
    try {
      await runWithWorkspace(workspace, sweep);
    } catch (error) {
      log.warn(`${label} retention sweep failed for workspace ${workspace}:`, error);
    }
  }
}

/**
 * Run server-side startup tasks exactly once per process: verify storage and
 * (unless USER encryption is locked) start all enabled MCP servers and arm the
 * scheduler.
 *
 * Memoized via a global promise so it is safe to call from multiple places
 * (the instrumentation startup hook and the /api/init route) without racing or
 * double-connecting servers. On failure the memo is cleared so a later caller
 * can retry.
 */
export function ensureBackendInitialized(): Promise<void> {
  const existing = getMemo('init');
  if (existing) return existing;
  const promise = runInitialization().catch(error => {
    // Allow a subsequent call (e.g. the /api/init route) to retry after a
    // failed startup instead of being stuck with a permanently rejected memo.
    setMemo('init', undefined);
    throw error;
  });
  setMemo('init', promise);
  return promise;
}

/**
 * Initialize a specific workspace (#406). The default workspace is initialized
 * at process startup; any other workspace is initialized lazily the first time a
 * request selects it, so its MCP servers connect and its triggers arm without
 * requiring a restart — and without a workspace nobody uses costing anything.
 */
export function ensureWorkspaceInitialized(workspace: string): Promise<void> {
  return runWithWorkspace(workspace, () => ensureBackendInitialized());
}

async function runInitialization(): Promise<void> {
  // Workspaces (#406): move/create <data root>/workspaces/default-workspace/*
  // BEFORE anything opens a path. Every storage, MCP and scheduler path is now
  // resolved inside a workspace, so running this first is what guarantees no
  // component ever reads or writes the legacy root layout mid-migration. It
  // rejects on an unresolvable source/destination conflict, which correctly
  // aborts startup rather than risking two divergent copies of the user's data.
  await migrateWorkspaceLayout();

  // Verify storage first - if this throws, callers (e.g. the route) surface it.
  await verifyStorage();
  await ensureVendoredFlowGenerator();
  // Detached task execution is process-local in v1. Any persisted working task
  // left behind by a prior process is visible as a terminal restart failure.
  reconcileOrphanedTasks().catch(error =>
    log.warn('Detached subflow task reconciliation failed at startup:', error)
  );

  // Refresh the Spotlight curated-server cache in the background. Deliberately
  // NOT awaited: the registry can be slow/unreachable and must never delay
  // startup — the Spotlight tab just shows the previous cache until this lands.
  refreshSpotlightServers().catch(error =>
    log.warn('Spotlight refresh failed at startup:', error)
  );

  // MCP servers read secret env values and the scheduler fires flows that
  // resolve ${global:...} bindings and decrypt model API keys. In locked USER
  // encryption mode those secrets are undecryptable, so this secret-dependent
  // startup must be DEFERRED until the user unlocks (see onUnlocked). In DEFAULT
  // mode — or once already unlocked — it runs immediately, exactly as before.
  if (await isEncryptionLocked()) {
    log.info(
      'Encryption locked — deferring MCP/scheduler startup until unlock'
    );
    return;
  }

  await startSecretDependentServices();
}

/**
 * Start the secret-dependent background services exactly once per process, in
 * order: provision shipped MCP configs, run the MCP server sweep, then arm the
 * scheduler. The scheduler is armed AFTER the MCP sweep so a catch-up or early
 * scheduled run doesn't race servers that are still connecting.
 *
 * Idempotent and concurrency-safe via a memoized global promise: safe to call
 * from both boot (runInitialization) and the unlock transition (onUnlocked)
 * without double-starting. A migration failure rejects and clears both startup
 * memos so a later initialization call can retry; downstream service failures
 * remain isolated to their existing logging paths.
 */
function startSecretDependentServices(): Promise<void> {
  const existing = getMemo('secret');
  if (!existing) {
    const promise = (async () => {
      log.info('Initializing MCP servers');
      try {
        // Issue #346: provisioning must finish before the enabled-server sweep.
        await migrateShippedMcpServers();
      } catch (error) {
        log.error('Failed to provision shipped MCP server configurations:', error);
        // Keep the startup retryable in-process; starting without the durable
        // records would silently omit the shipped servers.
        setMemo('secret', undefined);
        throw error;
      }

      // startEnabledServers() never rejects in practice (it catches per-server
      // failures) and always clears the startup flag in its own finally, so we
      // don't need to manage that flag here - just guard against the unexpected.
      await mcpService.startEnabledServers().catch(error => {
        log.error('Failed to start enabled servers:', error);
      });

      // Resume durable REMOTE MCP tasks (#404) AFTER the MCP sweep: resuming
      // needs live clients so each record's server/config identity can be
      // verified before a single tasks/get is sent. Deliberately not awaited —
      // a slow remote server must never delay the scheduler.
      resumeRemoteMcpTasks().catch(error =>
        log.warn('Remote MCP task resume failed at startup:', error)
      );

      // Arm planned-execution triggers AFTER the MCP sweep so a catch-up or
      // early scheduled run doesn't race servers that are still connecting.
      // start() is idempotent and catches per-execution arming failures.
      await getSchedulerService()
        .start()
        .catch(error => log.error('Failed to start scheduler:', error));

      // Arm the run-resource retention sweep (#251). Independent of secrets, but
      // armed here so it shares the once-per-process startup path.
      try {
        armRetentionSweep();
      } catch (error) {
        log.error('Failed to arm run-resource retention sweep:', error);
      }
    })();
    setMemo('secret', promise);
    return promise;
  }
  return existing;
}

/**
 * Unlock transition hook: start the secret-dependent services that were
 * deferred at boot while USER encryption was locked (Stage 3 of the #16 fix).
 * Called from the authenticate/unlock path once the server unlock DEK is in
 * memory — no FLUJO restart required.
 *
 * Idempotent: shares one memoized promise with the boot path, so repeated
 * unlock attempts never double-start MCP servers or double-arm the scheduler.
 * A no-op in DEFAULT mode (encryption not USER), where boot already started
 * everything.
 */
export async function onUnlocked(): Promise<void> {
  if (!(await isUserEncryptionEnabled())) {
    // DEFAULT mode: secret-dependent services started at boot already.
    return;
  }
  log.info('Encryption unlocked — starting deferred MCP/scheduler startup');
  await startSecretDependentServices();
}
