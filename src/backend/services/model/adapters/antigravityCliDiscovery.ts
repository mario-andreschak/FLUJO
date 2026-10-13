import path from 'node:path';
import { readStableFile } from '@/utils/readStableFile';
import { modelCache } from '../cache';
import type { NormalizedModel } from '@/shared/types/model/response';
import { hasExecutionExtensionContext, ExecutionExtensionError } from '@/backend/execution/extensions';
import { ANTIGRAVITY_CLI_VERSION, prepareAntigravityCliRuntime } from './antigravityCliRuntime';
import { readAntigravityCliCommand, isAntigravityCliInstalled } from './antigravityCliProcess';

export interface AntigravityRuntimeStatus {
  configuredVersion: string; installed: boolean; verified: boolean; actualVersion: string | null;
}

export async function inspectAntigravityRuntime(): Promise<AntigravityRuntimeStatus> {
  if (hasExecutionExtensionContext()) throw new ExecutionExtensionError('execution_model_adapter_forbidden');
  const status: AntigravityRuntimeStatus = { configuredVersion: ANTIGRAVITY_CLI_VERSION,
    installed: isAntigravityCliInstalled(), verified: false, actualVersion: null };
  const runtime = await prepareAntigravityCliRuntime({ model: 'default', maxTurns: 1, apiKey: '', diagnosticsOnly: true });
  try {
    const version = (await readAntigravityCliCommand(runtime, 'version')).trim();
    if (/^\d+\.\d+\.\d+$/.test(version)) status.actualVersion = version;
    status.verified = status.actualVersion === status.configuredVersion;
  } catch { /* Missing/changed runtime is unavailable, never a successful probe. */ }
  finally { await runtime.cleanup(); }
  return status;
}

export function normalizeAntigravityCatalog(value: unknown): NormalizedModel[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Antigravity returned an unsupported model catalog.');
  const envelope = value as { models?: unknown; entitlementVerified?: unknown };
  if (envelope.entitlementVerified !== false || !Array.isArray(envelope.models)
      || !envelope.models.length || envelope.models.length > 512) throw new Error('Antigravity returned an unsupported model catalog.');
  const seen = new Set<string>();
  return envelope.models.map((record: unknown) => {
    if (!record || typeof record !== 'object') throw new Error('Antigravity returned an unsupported model catalog.');
    const model = record as { id?: unknown; name?: unknown };
    if (typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id)
        || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 500
        || /[\x00-\x1f\x7f]/.test(model.name) || seen.has(model.id)) throw new Error('Antigravity returned an unsupported model catalog.');
    seen.add(model.id);
    return { id: model.id, name: model.name, description: 'Listed by the verified Antigravity runtime. Account or API-key access must be tested separately.' };
  });
}

export async function fetchAntigravityCliModels(apiKey: string): Promise<NormalizedModel[]> {
  if (hasExecutionExtensionContext()) throw new ExecutionExtensionError('execution_model_adapter_forbidden');
  const runtime = await prepareAntigravityCliRuntime({ model: 'default', maxTurns: 1, apiKey });
  try {
    // Verification precedes cached results. A changed runtime cannot keep an
    // earlier catalog alive, and authentication rotation gets a new identity.
    const actualVersion = (await readAntigravityCliCommand(runtime, 'version')).trim();
    if (actualVersion !== ANTIGRAVITY_CLI_VERSION) throw new Error('Antigravity runtime version is unsupported. Reinstall or update FLUJO.');
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
    const models = normalizeAntigravityCatalog(JSON.parse(await readAntigravityCliCommand(runtime, 'models')));
    if (identity) modelCache.set(identity, models);
    return models;
  } finally { await runtime.cleanup(); }
}
