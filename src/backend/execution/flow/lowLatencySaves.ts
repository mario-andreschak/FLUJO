import { loadItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';
import type { SharedState } from './types';

/**
 * Opt-in "fewer saves per turn" (#1408).
 *
 * A flow turn saves the whole conversation at every step boundary: before and
 * after each step, when the run starts and when it ends. Most of these saves
 * are written again a few milliseconds later by the next one. When enabled
 * (`experimental.lowLatencySaves`, or FLUJO_LOW_LATENCY_SAVES=1), the step
 * boundaries that carry no tool effect and the successful end of a run update
 * the conversation in memory and in the event log only; the next full save of
 * the run writes them (see `RecoveryDurability` in recoveryCheckpoint.ts).
 *
 * Never deferred: the checkpoints before and after a tool that may change
 * something, the start of a run, pauses, failures and the final save. So a
 * crash still cannot repeat a tool's side effect. What changes after a crash
 * mid-turn is only which step the interrupted turn names as its last one.
 *
 * Debugger, Persona and execution-extension runs always save at every step.
 */

const log = createLogger('backend/execution/flow/lowLatencySaves');
const SETTING_REFRESH_MS = 1_000;
const settings = new Map<string, { value: boolean; at: number }>();

/** The experimental setting, or FLUJO_LOW_LATENCY_SAVES for headless installs. */
export async function isLowLatencySavesEnabled(): Promise<boolean> {
  const configured = process.env.FLUJO_LOW_LATENCY_SAVES?.trim();
  if (configured) return configured === '1' || configured.toLowerCase() === 'true';
  const workspace = getCurrentWorkspace();
  const now = Date.now();
  const cached = settings.get(workspace);
  if (cached && now - cached.at < SETTING_REFRESH_MS) return cached.value;
  let value = false;
  try {
    const stored = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    value = stored?.experimental?.lowLatencySaves === true;
  } catch (error) {
    log.warn('Could not read the low-latency saves setting; saving at every step', error);
  }
  settings.set(workspace, { value, at: now });
  return value;
}

/** Whether this run may leave a step boundary's save to its next full save. */
export async function mayDeferConversationSave(state: SharedState): Promise<boolean> {
  if (state.ephemeral || state.debugMode || state.personaAttribution
      || state.executionExtensionContext || state.executionExtensionOwned) return false;
  return isLowLatencySavesEnabled();
}
