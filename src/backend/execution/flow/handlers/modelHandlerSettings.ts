// Settings the model handler reads from the saved Settings blob. Each read is best-effort and falls back to the default.
import { loadItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/flow/execution/handlers/modelHandlerSettings');

export async function isExperimentalFlagEnabled(name: 'claudeSessionResume'): Promise<boolean> {
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    return Boolean(settings?.experimental?.[name]);
  } catch (err) {
    log.warn(`Failed to read ${name} setting; defaulting to disabled`, { err });
    return false;
  }
}

/**
 * Read the experimental summarizing-compaction settings (issue #248) from the
 * persisted Settings blob. Best-effort: any failure reads as disabled, so the
 * completion path keeps its existing (wire-only) behaviour.
 */
export async function getCompactionGlobalSettings(): Promise<{
  compactionEnabled?: boolean;
  compactionBufferTokens?: number;
  compactionKeepTokens?: number;
  compactionThresholdPercent?: number;
  visualCompactionEnabled?: boolean;
  visualCompactionToolResultsOnly?: boolean;
  visualCompactionEvaluationMode?: boolean;
}> {
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    const exp = settings?.experimental;
    return {
      compactionEnabled: exp?.compactionEnabled,
      compactionBufferTokens: exp?.compactionBufferTokens,
      compactionKeepTokens: exp?.compactionKeepTokens,
      compactionThresholdPercent: exp?.compactionThresholdPercent,
      visualCompactionEnabled: exp?.visualCompactionEnabled,
      visualCompactionToolResultsOnly: exp?.visualCompactionToolResultsOnly,
      visualCompactionEvaluationMode: exp?.visualCompactionEvaluationMode,
    };
  } catch (err) {
    log.warn('Failed to read compaction settings; defaulting to disabled', { err });
    return { compactionEnabled: false, visualCompactionEnabled: false };
  }
}

/**
 * Read the `autoUnloadOllamaModels` flag from persisted settings.
 * Best-effort: any failure returns false (disabled).
 */
export async function isAutoUnloadOllamaEnabled(): Promise<boolean> {
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    return Boolean(settings?.experimental?.autoUnloadOllamaModels);
  } catch (err) {
    log.warn('Failed to read autoUnloadOllamaModels setting; defaulting to disabled', { err });
    return false;
  }
}

/**
 * Read the opt-in `toolDescriptionMaxChars` cap from the persisted Settings
 * blob. Best-effort like the flag above: any failure (or a missing value) reads
 * as 0, which leaves every tool description intact and keeps only the lossless
 * trimming tier active.
 */
export async function toolDescriptionCap(): Promise<number> {
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    const cap = settings?.experimental?.toolDescriptionMaxChars;
    return typeof cap === 'number' && cap > 0 ? cap : 0;
  } catch (err) {
    log.warn('Failed to read toolDescriptionMaxChars setting; leaving descriptions intact', { err });
    return 0;
  }
}

/**
 * Read the opt-in `historyKeepRecentMessages` compaction window from persisted
 * Settings (issue #286). Missing/invalid reads as 12 (the historical
 * `compactForWire` default), so behaviour is unchanged unless the user lowers
 * it to let short-but-tool-heavy conversations be compacted. Clamped to >= 2 so
 * a tail can never be too small to hold a tool_calls/tool pair verbatim.
 */
export async function historyKeepRecentMessages(): Promise<number> {
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    const keep = settings?.experimental?.historyKeepRecentMessages;
    if (typeof keep === 'number' && Number.isFinite(keep)) {
      return Math.max(2, Math.floor(keep));
    }
    return 6;  // Reduced from 12 to 6 to enable wire compaction for short-but-tool-heavy conversations
  } catch (err) {
    log.warn('Failed to read historyKeepRecentMessages setting; using default 6', { err });
    return 6;
  }
}
