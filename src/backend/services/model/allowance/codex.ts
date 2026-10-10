import { createHash } from 'node:crypto';
import type { AllowanceSnapshot, AllowanceWindow } from '@/shared/types/model/allowance';
import { allowanceAccountKey } from './store';
import { readCodexAuthForTransfer } from '../adapters/codexAuth';
import { prepareCodexRuntimeEnvironment, type CodexRuntimeEnvironment } from '../adapters/codexRuntimeHome';
import { startOwnedCodexAppServer, assertCodexOwnedProcessRegistration } from '../adapters/codexAppServerProcess';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Installed CLI 0.160.1 schema; aliases are quota buckets, not model names.
 * https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
 */
export function normalizeCodexAllowance(value: unknown, observedAt = new Date().toISOString()): AllowanceSnapshot {
  const data = record(value), multiple = record(data?.rateLimitsByLimitId), legacy = record(data?.rateLimits);
  const legacyId = typeof legacy?.limitId === 'string' && legacy.limitId ? legacy.limitId : 'codex';
  const buckets = multiple ? Object.entries(multiple).slice(0, 64) : [[legacyId, legacy]];
  const windows: AllowanceWindow[] = [];
  for (const [bucketId, value] of buckets) {
    const bucket = record(value);
    if (!bucket || typeof bucketId !== 'string') continue;
    const label = typeof bucket.limitName === 'string' && bucket.limitName.trim() ? bucket.limitName.slice(0, 128) : bucketId.slice(0, 128);
    for (const kind of ['primary', 'secondary'] as const) {
      const row = record(bucket[kind]);
      if (!row) continue;
      const used = row.usedPercent, reset = row.resetsAt, duration = row.windowDurationMins;
      windows.push({
        id: `${bucketId.slice(0, 128)}:${kind}`,
        label: `${label} · ${typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0 ? `${duration} minutes` : kind}`,
        remainingPercent: typeof used === 'number' && Number.isFinite(used) && used >= 0 ? Math.max(0, 100 - used) : null,
        resetAt: typeof reset === 'number' && Number.isSafeInteger(reset) && reset >= 0 && reset * 1000 <= 8.64e15 ? new Date(reset * 1000).toISOString() : null,
      });
    }
  }
  return { provider: 'codex', source: 'codex-app-server', observedAt, windows };
}

async function loginIdentity() {
  const bytes = await readCodexAuthForTransfer();
  try {
    const auth = JSON.parse(bytes.toString('utf8')) as { tokens?: { account_id?: unknown } };
    const accountId = typeof auth.tokens?.account_id === 'string' ? auth.tokens.account_id : undefined;
    const revision = createHash('sha256').update(bytes).digest('hex');
    return { accountKey: allowanceAccountKey('codex', JSON.stringify([accountId ?? null, revision])), accountId };
  } finally { bytes.fill(0); }
}

/** Passive: reads the current authoritative file-backed login; no child/network/sync. */
export async function readCodexAllowanceAccountKey(): Promise<string> {
  return (await loginIdentity()).accountKey;
}

/** Narrow telemetry conversation over the existing owned transport. No threads,
 * turns, models, tools, credit redemption, email, or login actions are requested.
 * The caller owns the total abort signal; stop always drains owned child closure.
 */
export async function readOwnedCodexAllowance(input: {
  executable: string; args?: string[]; runtime: CodexRuntimeEnvironment; signal: AbortSignal;
  timeoutMs: number; expectedAccountId?: string;
}): Promise<AllowanceSnapshot> {
  const owner = Object.freeze({});
  const child = await startOwnedCodexAppServer({
    executable: input.executable, args: input.args, cwd: input.runtime.workingDirectory,
    env: { ...input.runtime.env, NODE_ENV: 'production' }, owner, signal: input.signal, admissionTimeoutMs: input.timeoutMs,
    register: async registration => { assertCodexOwnedProcessRegistration(registration, owner); },
    onNotification: () => {},
  });
  try {
    await child.request('initialize', { clientInfo: { name: 'flujo_allowance', version: '1' } }, input.timeoutMs);
    child.notify('initialized');
    const account = record(await child.request('account/read', { refreshToken: false }, input.timeoutMs));
    if (record(account?.account)?.type !== 'chatgpt') throw new Error('CODEX_ALLOWANCE_UNAVAILABLE');
    const result = await child.request('account/rateLimits/read', { excludeResetCreditDetails: true }, input.timeoutMs);
    const accountId = record(result)?.accountId;
    if (accountId !== undefined && accountId !== null && (typeof accountId !== 'string'
      || (input.expectedAccountId !== undefined && accountId !== input.expectedAccountId))) throw new Error('CODEX_ALLOWANCE_ACCOUNT_CHANGED');
    input.signal.throwIfAborted();
    return normalizeCodexAllowance(result);
  } finally { await child.stop(); }
}

/** Explicit user refresh only. Preparation cannot be cancelled internally;
 * after deadline it is drained and cannot spawn a child. Owned process closure
 * can additionally take the transport's bounded seven-second shutdown window.
 */
export async function collectCodexAllowance(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ accountKey: string; snapshot: AllowanceSnapshot }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('CODEX_ALLOWANCE_UNAVAILABLE');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const before = await loginIdentity();
    controller.signal.throwIfAborted();
    const runtime = await prepareCodexRuntimeEnvironment(true);
    controller.signal.throwIfAborted();
    const { Codex } = await import('@openai/codex-sdk');
    const codex = new Codex();
    // SDK's native executable resolver is private but is the same installed
    // CLI selection used by Codex execution; never select an arbitrary PATH CLI.
    const executable = (codex as unknown as { exec: { executablePath: string } }).exec.executablePath;
    const snapshot = await readOwnedCodexAllowance({ executable, runtime, signal: controller.signal, timeoutMs, expectedAccountId: before.accountId });
    const after = await loginIdentity();
    controller.signal.throwIfAborted();
    if (before.accountKey !== after.accountKey) throw new Error('CODEX_ALLOWANCE_ACCOUNT_CHANGED');
    return { accountKey: before.accountKey, snapshot };
  } catch { throw new Error('CODEX_ALLOWANCE_UNAVAILABLE'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
