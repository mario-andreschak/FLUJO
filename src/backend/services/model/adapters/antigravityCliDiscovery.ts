import path from 'node:path';
import { createLogger } from '@/utils/logger';
import { readStableFile } from '@/utils/readStableFile';
import { modelCache } from '../cache';
import type { NormalizedModel } from '@/shared/types/model/response';
import { groupAntigravityEfforts } from '@/shared/types/model/antigravityEffort';
import { hasExecutionExtensionContext, ExecutionExtensionError } from '@/backend/execution/extensions';
import { ANTIGRAVITY_CLI_VERSION, prepareAntigravityCliRuntime } from './antigravityCliRuntime';
import {
  readAntigravityCliCommand, isAntigravityCliInstalled, isSupportedAntigravityVersion, antigravityVersionError, isTransientAntigravityFailure,
} from './antigravityCliProcess';

const log = createLogger('backend/services/model/adapters/antigravityCliDiscovery');

export type AntigravityRuntimeProblem = 'missing' | 'outdated' | 'unsupported' | 'incompatible' | 'unavailable';
export interface AntigravityRuntimeStatus {
  configuredVersion: string; installed: boolean; verified: boolean; actualVersion: string | null;
  /** Present when the runtime cannot be used: a fixed code and a message written by FLUJO. */
  problem?: { code: AntigravityRuntimeProblem; message: string };
}

const UNAVAILABLE_MESSAGE = 'FLUJO could not start a compatible Antigravity CLI. Check internet access and installation permissions, or repair the official agy installation, then retry.';
const PROBLEMS: Record<string, AntigravityRuntimeProblem> = {
  AGY_MISSING: 'missing', AGY_OUTDATED: 'outdated', AGY_UNSUPPORTED_MAJOR: 'unsupported',
  AGY_INCOMPATIBLE: 'incompatible', AGY_START_FAILED: 'unavailable',
};

/** Only errors raised by FLUJO's own runtime check carry a code; their text is fixed. */
function runtimeProblem(error: unknown): NonNullable<AntigravityRuntimeStatus['problem']> {
  const code = PROBLEMS[String((error as { code?: unknown } | undefined)?.code ?? '')];
  return code && error instanceof Error ? { code, message: error.message } : { code: 'unavailable', message: UNAVAILABLE_MESSAGE };
}

export async function inspectAntigravityRuntime(): Promise<AntigravityRuntimeStatus> {
  if (hasExecutionExtensionContext()) throw new ExecutionExtensionError('execution_model_adapter_forbidden');
  const status: AntigravityRuntimeStatus = { configuredVersion: ANTIGRAVITY_CLI_VERSION,
    installed: isAntigravityCliInstalled(), verified: false, actualVersion: null };
  const runtime = await prepareAntigravityCliRuntime({ model: 'default', maxTurns: 1, apiKey: '', diagnosticsOnly: true });
  try {
    const version = (await readAntigravityCliCommand(runtime, 'version')).trim();
    status.installed = isAntigravityCliInstalled();
    if (/^\d+\.\d+\.\d+$/.test(version)) status.actualVersion = version;
    status.verified = isSupportedAntigravityVersion(version);
    if (!status.verified) status.problem = runtimeProblem(antigravityVersionError(version));
  } catch (error) {
    // A missing or changed runtime is unavailable, never a successful probe.
    status.problem = runtimeProblem(error);
    const version = (error as { version?: unknown }).version;
    if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version)) status.actualVersion = version;
  } finally { await runtime.cleanup(); }
  return status;
}

export function normalizeAntigravityCatalog(value: unknown): NormalizedModel[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Antigravity returned an unsupported model catalog.');
  const envelope = value as { models?: unknown; entitlementVerified?: unknown };
  if (envelope.entitlementVerified !== false || !Array.isArray(envelope.models)
      || !envelope.models.length || envelope.models.length > 512) throw new Error('Antigravity returned an unsupported model catalog.');
  const seen = new Set<string>();
  const listed = envelope.models.map((record: unknown) => {
    if (!record || typeof record !== 'object') throw new Error('Antigravity returned an unsupported model catalog.');
    const model = record as { id?: unknown; name?: unknown };
    if (typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id)
        || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 500
        || /[\x00-\x1f\x7f]/.test(model.name) || seen.has(model.id)) throw new Error('Antigravity returned an unsupported model catalog.');
    seen.add(model.id);
    return { id: model.id, name: model.name };
  });
  return groupAntigravityEfforts(listed).map(model => ({ ...model,
    description: 'Listed by the verified Antigravity runtime. Account or API-key access must be tested separately.' }));
}

/** The last list each runtime/credential identity returned, used when a refresh fails briefly. */
const LAST_KNOWN_TTL_MS = 24 * 60 * 60 * 1000;
const LAST_KNOWN_LIMIT = 32;
const lastKnownCatalogs = new Map<string, { models: NormalizedModel[]; at: number }>();
const STALE_DESCRIPTION = 'Listed earlier by the Antigravity CLI. The latest list could not be loaded; reload to try again.';

function rememberCatalog(key: string, models: NormalizedModel[]): void {
  lastKnownCatalogs.delete(key);
  lastKnownCatalogs.set(key, { models, at: Date.now() });
  while (lastKnownCatalogs.size > LAST_KNOWN_LIMIT) lastKnownCatalogs.delete(lastKnownCatalogs.keys().next().value!);
}

async function readCatalog(runtime: Awaited<ReturnType<typeof prepareAntigravityCliRuntime>>): Promise<NormalizedModel[]> {
  try {
    return normalizeAntigravityCatalog(JSON.parse(await readAntigravityCliCommand(runtime, 'models')));
  } catch (error) {
    if (!isTransientAntigravityFailure(error)) throw error;
    await new Promise(resolve => setTimeout(resolve, 1000));
    return normalizeAntigravityCatalog(JSON.parse(await readAntigravityCliCommand(runtime, 'models')));
  }
}

export async function fetchAntigravityCliModels(apiKey: string): Promise<NormalizedModel[]> {
  if (hasExecutionExtensionContext()) throw new ExecutionExtensionError('execution_model_adapter_forbidden');
  const runtime = await prepareAntigravityCliRuntime({ model: 'default', maxTurns: 1, apiKey });
  try {
    // Verification precedes cached results. A changed runtime cannot keep an
    // earlier catalog alive, and authentication rotation gets a new identity.
    const actualVersion = (await readAntigravityCliCommand(runtime, 'version')).trim();
    if (!isSupportedAntigravityVersion(actualVersion)) throw antigravityVersionError(actualVersion);
    let material: string | undefined = apiKey || undefined;
    if (!apiKey) {
      try { material = (await readStableFile(path.join(runtime.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 64 * 1024)).toString('base64'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Antigravity authentication is unavailable. Retry after signing in.'); }
    }
    // Native keyring changes are not observable as a file identity. Do not
    // cache that mode across requests or infer entitlement from its catalog.
    const identity = material === undefined ? undefined : { baseUrl: '', provider: 'antigravity-cli',
      adapter: 'antigravity-cli', profileId: `antigravity-cli:${actualVersion}:${apiKey ? 'api-key' : 'account'}`,
      credentialFingerprint: modelCache.credentialFingerprint(material) };
    const cached = identity && modelCache.get(identity);
    if (cached) return cached;
    const lastKnownKey = identity && JSON.stringify([identity.profileId, identity.credentialFingerprint]);
    let models: NormalizedModel[];
    try {
      models = await readCatalog(runtime);
    } catch (error) {
      const lastKnown = lastKnownKey ? lastKnownCatalogs.get(lastKnownKey) : undefined;
      if (!lastKnown || !isTransientAntigravityFailure(error) || Date.now() - lastKnown.at > LAST_KNOWN_TTL_MS) throw error;
      log.warn('Antigravity model list refresh failed; showing the last known list');
      return lastKnown.models.map(model => ({ ...model, description: STALE_DESCRIPTION }));
    }
    if (identity) modelCache.set(identity, models);
    if (lastKnownKey) rememberCatalog(lastKnownKey, models);
    return models;
  } finally { await runtime.cleanup(); }
}

/** Test-only: forget last known catalogs. */
export function _clearAntigravityCatalogsForTests(): void {
  lastKnownCatalogs.clear();
}
