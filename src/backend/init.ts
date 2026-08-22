import { Cron } from 'croner';
import { verifyStorage } from '@/utils/storage/backend';
import { mcpService } from '@/backend/services/mcp';
import { sweepOldRunResources } from '@/backend/services/runResources';
import { snapshotStore } from '@/backend/services/snapshot/SnapshotStore';
import { reconcileOrphanedTasks, sweepOldSubflowTasks } from '@/backend/services/subflowTasks';
import { refreshSpotlightServers } from '@/backend/services/spotlight';
import { getSchedulerService } from '@/backend/services/scheduler';
import { isEncryptionLocked, isUserEncryptionEnabled } from '@/utils/encryption/secure';
import { createLogger } from '@/utils/logger';
import { ensureDefaultFlujoAgent } from '@/backend/services/flow/defaultAgent';
import {
  inspectAndReconcilePersonaRuntime,
  listPersonas,
  reconcilePersonaRoleBehaviors,
  startPersonaFlowDispatcher,
  sweepMemoryCandidates,
} from '@/backend/services/enduringAgents';
import { migrateShippedMcpServers } from '@/backend/services/mcp/shippedServerMigration';
import { migrateEnduringAgentDirectoryShards } from '@/backend/services/enduringAgents/directoryShardingMigration';
import { sweepOldMcpRemoteTasks } from '@/backend/services/mcp/remoteTaskStore';
import { resumeRemoteMcpTasks } from '@/backend/services/mcp/remoteTaskResume';
import { migrateWorkspaceLayout } from '@/backend/services/workspace/migration';
import {
  DEFAULT_WORKSPACE,
  ensureWorkspaceDirs,
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
  // Hourly snapshot storage cleanup cron (issue #414). Global-guarded so
  // Next.js hot-reload / duplicate module instantiation can't arm it twice.
  // The cleanup respects the retention policy and automatically compacts git history.
  var __flujo_snapshot_cleanup_cron: Cron | undefined;
  // Hourly memory candidate lifecycle sweep (issue #452): expiry, auto-promotion, and conflict repair.
  var __flujo_memory_lifecycle_cron: Cron | undefined;
  // Workspaces (#406): per-workspace copies of the two memos above, for every
  // workspace OTHER than the default. The default workspace keeps using the
  // original globals, so existing callers and tests are untouched.
  var __flujo_workspace_init_promises: Map<string, Promise<void>> | undefined;
  var __flujo_workspace_secret_promises: Map<string, Promise<void>> | undefined;
  // Issue #413: process shutdown hooks are armed once per process, and the
  // teardown itself is memoized so several signals arriving together (SIGINT then
  // SIGTERM from a supervisor) share ONE teardown instead of racing two.
  var __flujo_shutdown_hooks_registered: boolean | undefined;
  var __flujo_shutdown_promise: Promise<void> | undefined;
}

/** Hard cap on how long MCP teardown may delay process exit. */
const SHUTDOWN_TIMEOUT_MS = 20_000;

/**
 * Tear down process-owned background services (issue #413).
 *
 * Before this existed FLUJO had no MCP shutdown at all: on SIGTERM/SIGINT every
 * stdio server child - and everything those had spawned - was simply abandoned to
 * the OS, which reparents rather than kills. Repeated start/stop cycles therefore
 * accumulated orphaned server trees until the machine was rebooted.
 *
 * Every workspace is torn down, because MCP runtimes are workspace-scoped (#406).
 * Memoized and never rejects: shutdown must be safe to call from several signal
 * handlers at once and must not be derailed by one uncooperative server.
 */
export function shutdownBackendServices(reason: string): Promise<void> {
  if (global.__flujo_shutdown_promise) return global.__flujo_shutdown_promise;
  const promise = (async () => {
    log.info(`Shutting down backend services (${reason})`);
    let workspaces: string[];
    try {
      workspaces = (await listWorkspaces()).map(w => w.name);
    } catch {
      workspaces = [DEFAULT_WORKSPACE];
    }
    for (const workspace of workspaces) {
      try {
        await runWithWorkspace(workspace, () => mcpService.disconnectAll(reason));
      } catch (error) {
        log.warn(`MCP teardown failed for workspace ${workspace}:`, error);
      }
    }
  })().catch(error => {
    log.warn('Backend shutdown encountered an error:', error);
  });
  global.__flujo_shutdown_promise = promise;
  return promise;
}

/**
 * Arm SIGINT/SIGTERM/SIGHUP handlers that tear down MCP servers before exit.
 *
 * The handlers exit the process themselves: installing a signal listener
 * suppresses Node's default terminate behaviour, so failing to exit would turn
 * Ctrl+C into "nothing happens". The timeout race guarantees a wedged server can
 * delay exit but never prevent it - shutdown that hangs forever is worse than
 * shutdown that force-exits with one orphan.
 */
function registerProcessShutdownHooks(): void {
  if (global.__flujo_shutdown_hooks_registered) return;
  global.__flujo_shutdown_hooks_registered = true;

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  // SIGHUP is not deliverable on every platform; arming it is best-effort.
  if (process.platform !== 'win32') signals.push('SIGHUP');

  for (const signal of signals) {
    try {
      process.once(signal, () => {
        log.info(`Received ${signal}; tearing down MCP servers before exit`);
        const timeout = new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            log.warn(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`);
            resolve();
          }, SHUTDOWN_TIMEOUT_MS);
          timer.unref?.();
        });
        void Promise.race([shutdownBackendServices(signal), timeout]).finally(() => {
          process.exit(0);
        });
      });
    } catch (error) {
      log.debug(`Could not arm ${signal} shutdown hook:`, error);
    }
  }
  log.info(`Armed process shutdown hooks (${signals.join(', ')})`);
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
  // Snapshot storage cleanup (issue #414): an hourly cron that respects the
  // retention policy, expires old captures, and compacts git history for idle
  // workspaces that have stopped capturing but still retain snapshots.
  if (!global.__flujo_snapshot_cleanup_cron) {
    global.__flujo_snapshot_cleanup_cron = new Cron('0 * * * *', { unref: true }, () => {
      void sweepEveryWorkspace('snapshot storage', () => snapshotStore.cleanup());
    });
    log.info('Armed snapshot storage cleanup sweep (hourly)');
  }
  // Memory candidate lifecycle sweep (issue #452): hourly expiry, auto-promotion, and conflict repair.
  if (!global.__flujo_memory_lifecycle_cron) {
    global.__flujo_memory_lifecycle_cron = new Cron('0 * * * *', { unref: true }, () => {
      void sweepEveryWorkspace('memory candidate lifecycle', () => sweepMemoryCandidates());
    });
    log.info('Armed memory candidate lifecycle sweep (hourly)');
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
  return runWithWorkspace(workspace, async () => {
    await ensureWorkspaceDirs(workspace);
    await ensureBackendInitialized();
  });
}

/**
 * Initialize every workspace discovered at process start.
 *
 * Automations are workspace-owned background work, so waiting until a user
 * opens a tab would leave schedules and webhooks in inactive workspaces
 * unarmed. Workspaces are initialized sequentially to avoid a startup stampede;
 * a broken workspace is logged and isolated from the others. Failure of the
 * installation-wide layout barrier or workspace enumeration still rejects.
 */
export async function ensureAllWorkspacesInitialized(): Promise<void> {
  await migrateWorkspaceLayout();
  const workspaces = await listWorkspaces();
  for (const workspace of workspaces) {
    try {
      await ensureWorkspaceInitialized(workspace.name);
    } catch (error) {
      log.error(`Initialization failed for workspace ${workspace.name}`, error);
    }
  }
}

async function runInitialization(): Promise<void> {
  // Workspaces (#406): move/create <data root>/workspaces/default-workspace/*
  // BEFORE anything opens a path. Every storage, MCP and scheduler path is now
  // resolved inside a workspace, so running this first is what guarantees no
  // component ever reads or writes the legacy root layout mid-migration. It
  // rejects on an unresolvable source/destination conflict, which correctly
  // aborts startup rather than risking two divergent copies of the user's data.
  await migrateWorkspaceLayout();

  // Arm shutdown BEFORE anything spawns a child process, so an early Ctrl+C
  // during a slow startup sweep still tears down whatever already connected.
  registerProcessShutdownHooks();

  // Verify storage first - if this throws, callers (e.g. the route) surface it.
  await verifyStorage();
  await ensureDefaultFlujoAgent();
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
      try {
        // Persona storage must be fully relocated after unlock and before any
        // reconciliation, dispatcher, or other runtime writer can start.
        await migrateEnduringAgentDirectoryShards();
      } catch (error) {
        log.error('Failed to migrate Persona record directory shards:', error);
        setMemo('secret', undefined);
        throw error;
      }

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

      // Repair durable Persona runtime projections and resume queued dispatches
      // only after unlock + MCP startup, so recovered Behavior runs cannot race
      // unavailable secrets or tool clients. Per-Persona failures stay visible
      // through the runtime observation returned by GET /v1/personas/:id.
      try {
        await reconcilePersonaRoleBehaviors();
        const personas = await listPersonas();
        await Promise.all(personas.map((persona) =>
          inspectAndReconcilePersonaRuntime(persona.id).catch(error => {
            log.warn(`Persona runtime reconciliation failed for ${persona.id}:`, error);
            return null;
          })
        ));
        await startPersonaFlowDispatcher();
      } catch (error) {
        log.error('Failed to start Persona Flow dispatcher:', error);
      }

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
  // Only the ambient workspace was unlocked. Sibling workspaces may use a
  // different DEK and must remain deferred until their own unlock transition.
  log.info(
    `Encryption unlocked — starting deferred MCP/scheduler startup for ${getCurrentWorkspace()}`,
  );
  const servicesAlreadyStarted = Boolean(getMemo('secret'));
  await startSecretDependentServices();
  // The once-only startup memo may already be settled when a workspace is
  // locked again and new Persona deliveries are admitted with startPump:false.
  // Every unlock therefore performs an idempotent durable kick/reconciliation
  // so those envelopes and scheduler projections cannot remain stranded.
  if (!servicesAlreadyStarted) return;
  await startPersonaFlowDispatcher().catch(error => {
    log.error('Failed to resume Persona Flow dispatcher after unlock:', error);
  });
  await getSchedulerService().reconcilePersonaSchedulerProjections(false).catch(error => {
    log.error('Failed to reconcile Persona scheduler projections after unlock:', error);
  });
}
