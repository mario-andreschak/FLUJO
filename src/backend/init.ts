import { verifyStorage } from '@/utils/storage/backend';
import { mcpService } from '@/backend/services/mcp';
import { refreshSpotlightServers } from '@/backend/services/spotlight';
import { getSchedulerService } from '@/backend/services/scheduler';
import { isEncryptionLocked, isUserEncryptionEnabled } from '@/utils/encryption/secure';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/init');

declare global {
  // The in-flight (or settled) initialization promise. Global-backed so the
  // startup hook (instrumentation) and the /api/init route share the SAME run
  // instead of each kicking off their own server-startup sweep and racing.
  // eslint-disable-next-line no-var
  var __flujo_init_promise: Promise<void> | undefined;
  // The in-flight (or settled) secret-dependent startup promise (MCP sweep +
  // scheduler arm). Global-backed and memoized so that both the boot path
  // (runInitialization) and the unlock transition (onUnlocked) drive it exactly
  // once per process — neither double-starts servers nor double-arms triggers.
  // Deliberately NOT captured by __flujo_init_promise: while USER encryption is
  // locked this work is skipped at boot and only runs later, at unlock.
  // eslint-disable-next-line no-var
  var __flujo_secret_services_promise: Promise<void> | undefined;
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
  if (!global.__flujo_init_promise) {
    global.__flujo_init_promise = runInitialization().catch(error => {
      // Allow a subsequent call (e.g. the /api/init route) to retry after a
      // failed startup instead of being stuck with a permanently rejected memo.
      global.__flujo_init_promise = undefined;
      throw error;
    });
  }
  return global.__flujo_init_promise;
}

async function runInitialization(): Promise<void> {
  // Verify storage first - if this throws, callers (e.g. the route) surface it.
  await verifyStorage();

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
 * order: the MCP server sweep, then arming the scheduler. The scheduler is
 * armed AFTER the MCP sweep so a catch-up or early scheduled run doesn't race
 * servers that are still connecting.
 *
 * Idempotent and concurrency-safe via a memoized global promise: safe to call
 * from both boot (runInitialization) and the unlock transition (onUnlocked)
 * without double-starting. The inner steps each catch their own failures, so
 * the memo always settles (a transient failure isn't retried automatically —
 * a FLUJO restart re-runs boot).
 */
function startSecretDependentServices(): Promise<void> {
  if (!global.__flujo_secret_services_promise) {
    global.__flujo_secret_services_promise = (async () => {
      log.info('Initializing MCP servers');
      // startEnabledServers() never rejects in practice (it catches per-server
      // failures) and always clears the startup flag in its own finally, so we
      // don't need to manage that flag here - just guard against the unexpected.
      await mcpService.startEnabledServers().catch(error => {
        log.error('Failed to start enabled servers:', error);
      });

      // Arm planned-execution triggers AFTER the MCP sweep so a catch-up or
      // early scheduled run doesn't race servers that are still connecting.
      // start() is idempotent and catches per-execution arming failures.
      await getSchedulerService()
        .start()
        .catch(error => log.error('Failed to start scheduler:', error));
    })();
  }
  return global.__flujo_secret_services_promise;
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
