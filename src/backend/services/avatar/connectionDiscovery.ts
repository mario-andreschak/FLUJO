import * as nodeModule from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Model } from '@/shared/types/model';
import { getProviderProfileById } from '@/shared/types/model/provider';
import type { AvatarConnectionDiscovery, AvatarConnectionCandidate } from '@/shared/types/avatar';
import { userCodexHome } from '@/backend/services/model/adapters/codexAuth';
import { inspectCodexLogin } from './codexLoginInspection';
import { readStableFile } from '@/utils/readStableFile';

type Runtime = AvatarConnectionCandidate['runtime'];

/** The SDK constructor resolves its own binary and does not start a process.
 * Checking PATH alone misses Flujo's bundled Codex runtime. */
export async function inspectCodexRuntime(): Promise<Runtime> {
  try {
    const { Codex } = await import('@openai/codex-sdk');
    new Codex();
    return 'available';
  } catch { return 'missing'; }
}

export async function inspectClaudeRuntime(): Promise<Runtime> {
  try {
    // Preserve native resolution in production, as shippedWorkspacePackages does.
    // Webpack rewrites a direct dynamic createRequire call into a broken shim.
    const nativeCreateRequire: typeof nodeModule.createRequire = Reflect.get(nodeModule, 'createRequire');
    const resolver = nativeCreateRequire(path.join(process.cwd(), 'package.json'));
    const sdk = resolver.resolve('@anthropic-ai/claude-agent-sdk');
    const sdkResolver = nativeCreateRequire(sdk);
    // SDK releases ship either cli.js or a platform-specific native package.
    if (await fs.stat(path.join(path.dirname(sdk), 'cli.js')).then(s => s.isFile(), () => false)) return 'available';
    let suffix = `${process.platform}-${process.arch}`;
    if (process.platform === 'linux') {
      const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
      if (!report?.header?.glibcVersionRuntime) suffix += '-musl';
    }
    const pkg = sdkResolver.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/package.json`);
    const executable = path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
    return await fs.stat(executable).then(s => s.isFile() ? 'available' : 'missing', () => 'missing');
  } catch { return 'missing'; }
}

function choices(provider: string): AvatarConnectionCandidate['modelChoices'] {
  return (getProviderProfileById(provider)?.defaultModels ?? []).map(id => ({ id, label: id, source: 'fallback' }));
}

/** Cached public catalog hints, never personal configuration or proof of entitlement. */
export function codexModelHints(value: unknown, now = Date.now()): AvatarConnectionCandidate['modelChoices'] {
  if (!value || typeof value !== 'object' || !('models' in value) || !Array.isArray(value.models)
      || !('fetched_at' in value) || typeof value.fetched_at !== 'string') return [];
  const updatedAt = Date.parse(value.fetched_at);
  if (!Number.isFinite(updatedAt) || updatedAt > now + 60_000 || now - updatedAt > 24 * 60 * 60_000) return [];
  return value.models.filter(model => model && typeof model === 'object' && model.visibility === 'list'
    && typeof model.slug === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(model.slug)).slice(0, 20)
    .map(model => ({ id: model.slug, label: model.slug, source: 'host-cache' as const, updatedAt }));
}

export async function inspectCodexModelHints(): Promise<AvatarConnectionCandidate['modelChoices']> {
  try {
    const file = path.join(userCodexHome(), 'models_cache.json');
    const bytes = await readStableFile(file, 8 * 1024 * 1024);
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return codexModelHints(value);
  } catch { return []; }
}

export interface DiscoveryDependencies {
  codexRuntime: () => Promise<Runtime>;
  claudeRuntime: () => Promise<Runtime>;
  codexLogin: typeof inspectCodexLogin;
  codexModels?: typeof inspectCodexModelHints;
}

/** No tests, paid calls, mutations, account identities, or personal settings. */
export async function discoverAvatarConnections(models: Model[], dependencies: DiscoveryDependencies = {
  codexRuntime: inspectCodexRuntime, claudeRuntime: inspectClaudeRuntime, codexLogin: inspectCodexLogin, codexModels: inspectCodexModelHints,
}): Promise<AvatarConnectionDiscovery> {
  const [codexRuntime, claudeRuntime, login, cachedModels] = await Promise.all([
    dependencies.codexRuntime(), dependencies.claudeRuntime(), dependencies.codexLogin(),
    dependencies.codexModels?.() ?? Promise.resolve([]),
  ]);
  const saved: AvatarConnectionCandidate[] = models.filter(m => m.supportsTools !== false).map(model => ({
    id: `saved:${model.id}`, kind: 'saved-model', label: model.displayName || model.name,
    host: 'flujo-server', modelId: model.id,
    runtime: model.adapter === 'codex-cli' ? codexRuntime : model.adapter === 'claude-cli' ? claudeRuntime : 'available',
    authentication: model.adapter === 'codex-cli' && !model.ApiKey ? login.authentication
      : model.adapter === 'claude-cli' && !model.ApiKey ? 'needs-connection' : 'configured',
    verification: 'untested',
    nextAction: model.adapter === 'claude-cli' && !model.ApiKey ? 'connect-token'
      : model.adapter === 'codex-cli' && !model.ApiKey && login.authentication !== 'login-detected'
        ? login.authentication === 'needs-connection' ? 'sign-in' : 'repair' : 'use-and-test',
    modelChoices: [{ id: model.name, label: model.name, source: 'saved' }],
  }));
  return {
    host: 'flujo-server', platform: process.platform, checkedAt: Date.now(),
    candidates: [...saved, {
      id: 'codex-subscription', kind: 'codex-subscription', label: 'Codex / ChatGPT', host: 'flujo-server',
      runtime: codexRuntime, ...login, verification: 'untested',
      nextAction: codexRuntime !== 'available' ? 'repair' : login.authentication === 'login-detected' ? 'use-and-test'
        : login.authentication === 'needs-connection' ? 'sign-in' : 'repair',
      modelChoices: cachedModels.length ? cachedModels : choices('codex'),
    }, {
      id: 'claude-subscription', kind: 'claude-subscription', label: 'Claude', host: 'flujo-server',
      runtime: claudeRuntime, authentication: 'needs-connection', verification: 'untested',
      nextAction: claudeRuntime === 'available' ? 'connect-token' : 'repair',
      reasonCode: 'saved-oauth-token-required', modelChoices: choices('claude-subscription'),
    }],
  };
}
