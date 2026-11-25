import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AllowanceSnapshot } from '@/shared/types/model/allowance';
import { prepareClaudeRuntimeEnvironment } from '../adapters/claudeRuntimeHome';
import { createClaudeOwnedProcessSpawner, assertClaudeOwnedProcessRegistration, type ClaudeOwnedProcessRegistration } from '../adapters/claudeOwnedProcess';
import { normalizeClaudeAllowance, claudeAllowanceSnapshot, claudeOAuthUsageResult, ClaudeAllowanceError } from './claude';
import { allowanceAccountKey } from './store';

export { ClaudeAllowanceError };

/** Reads a successful body within 64 KiB; any other answer is only drained. */
async function boundedBody(response: Response): Promise<string> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) throw new ClaudeAllowanceError('collection-failed');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Same usage endpoint as the installed official CLI. Its response is
 * authoritative even when the SDK's environment-token lane lacks scope metadata. */
export async function readClaudeOAuthAllowance(credential: string, signal: AbortSignal): Promise<AllowanceSnapshot> {
  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET', headers: { Authorization: 'Bearer ' + credential, 'anthropic-beta': 'oauth-2025-04-20' },
    cache: 'no-store', redirect: 'error', signal,
  });
  const body = await boundedBody(response);
  return claudeOAuthUsageResult({ status: response.status, retryAfter: response.headers.get('retry-after'), body },
    allowanceAccountKey('claude', credential));
}

/** Initialize an idle SDK process and read /usage. The input stream never yields
 * a prompt: this does not start inference, invoke tools, or consume a model turn. */
export async function collectClaudeAccountAllowance(credential: string, options: {
  signal?: AbortSignal; timeoutMs?: number;
} = {}): Promise<AllowanceSnapshot> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('CLAUDE_ALLOWANCE_UNAVAILABLE');
  const controller = new AbortController();
  let query: Query | undefined;
  let registration: ClaudeOwnedProcessRegistration | undefined;
  let releaseInput!: () => void;
  const inputClosed = new Promise<void>(resolve => { releaseInput = resolve; });
  const abort = () => { controller.abort(); releaseInput(); query?.close(); };
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('CLAUDE_ALLOWANCE_UNAVAILABLE')), { once: true });
  });
  // Preparation can finish after cancellation; every subsequent boundary checks the signal.
  void aborted.catch(() => {});
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const owner = Object.freeze({});
  const owned = createClaudeOwnedProcessSpawner({
    owner, requestSdkStop: abort,
    register: async value => { assertClaudeOwnedProcessRegistration(value, owner); registration = value; },
  });
  try {
    if (options.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    const runtime = await prepareClaudeRuntimeEnvironment();
    controller.signal.throwIfAborted();
    const env: Record<string, string> = { ...runtime.env, CLAUDE_CODE_OAUTH_TOKEN: credential };
    // A host API key or gateway must not override the selected subscription identity.
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    controller.signal.throwIfAborted();
    query = sdk.query({
      prompt: (async function* () { await inputClosed; })(),
      options: {
        cwd: runtime.workingDirectory, env, abortController: controller,
        settingSources: [], settings: { disableAllHooks: true },
        tools: [], mcpServers: {}, strictMcpConfig: true, plugins: [], persistSession: false,
        canUseTool: async () => ({ behavior: 'deny', message: 'Allowance collection has no tools.' }),
        spawnClaudeCodeProcess: owned.spawnClaudeCodeProcess,
        stderr: () => {},
      },
    });
    await Promise.race([owned.ready, aborted]);
    await Promise.race([query.initializationResult(), aborted]);
    const value = await Promise.race([
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), aborted,
    ]);
    controller.signal.throwIfAborted();
    const observation = normalizeClaudeAllowance(value, allowanceAccountKey('claude', credential));
    if (!observation.available) return await readClaudeOAuthAllowance(credential, controller.signal);
    return claudeAllowanceSnapshot(observation);
  } catch (cause) {
    throw cause instanceof ClaudeAllowanceError ? cause : new ClaudeAllowanceError('collection-failed', cause);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    releaseInput(); query?.close(); controller.abort();
    // Hold ownership until the SDK's child and its pipes have actually closed.
    if (query && !registration) await owned.ready.catch(() => {});
    if (registration) await registration.close;
  }
}
