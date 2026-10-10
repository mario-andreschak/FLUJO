import { createHash } from 'node:crypto';
import type { NormalizedModel } from '@/shared/types/model/response';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { prepareCodexRuntimeEnvironment } from './codexRuntimeHome';
import { readCodexAuthForTransfer } from './codexAuth';
import { startOwnedCodexAppServer, assertCodexOwnedProcessRegistration } from './codexAppServerProcess';
import { acquireOrdinaryCodexExecutable } from './codexRuntimeUpdate';

const MAX_MODELS = 1000;
const caches = new Map<string, { expires: number; models: NormalizedModel[] }>();
const pending = new Map<string, Promise<NormalizedModel[]>>();
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function normalizeCodexModels(rows: unknown[]): NormalizedModel[] {
  const found = new Map<string, NormalizedModel>();
  for (const value of rows) {
    const row = record(value);
    if (!row || row.hidden === true || typeof row.model !== 'string' || !row.model.trim() || row.model.length > 256) continue;
    const efforts = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.flatMap(value => {
      const effort = record(value)?.reasoningEffort;
      return typeof effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort) ? [effort] : [];
    }) : [];
    const modalities = Array.isArray(row.inputModalities) ? row.inputModalities.filter((item): item is string => typeof item === 'string') : undefined;
    found.set(row.model, {
      id: row.model, name: typeof row.displayName === 'string' ? row.displayName.slice(0, 256) : row.model,
      ...(typeof row.description === 'string' ? { description: row.description.slice(0, 4096) } : {}),
      ...(efforts.length ? { reasoningEfforts: [...new Set(efforts)] } : {}),
      ...(modalities ? { inputModalities: modalities, visionInputCapability: modalities.includes('image') ? 'supported' : 'unsupported' } : {}),
    });
  }
  return [...found.values()];
}

async function identity(): Promise<string> {
  const bytes = await readCodexAuthForTransfer();
  try { return createHash('sha256').update(bytes).digest('hex'); }
  finally { bytes.fill(0); }
}

/** Same file-backed login and executable as ordinary inference. No thread/turn/tool calls.
 * Model/list is a client/account catalogue, never a guarantee of inference entitlement.
 */
export async function fetchCodexModels(): Promise<NormalizedModel[]> {
  const before = await identity();
  const lease = await acquireOrdinaryCodexExecutable();
  try {
    const executable = lease.executable;
    const key = JSON.stringify([getWorkspaceDataDir(), before, executable]);
    const cached = caches.get(key);
    if (cached && cached.expires > Date.now()) return cached.models;
    const active = pending.get(key);
    if (active) return active;
    const operation = (async () => {
      const runtime = await prepareCodexRuntimeEnvironment(true);
      const owner = Object.freeze({});
      const child = await startOwnedCodexAppServer({
        executable, args: ['app-server'], env: { ...runtime.env, NODE_ENV: 'production' }, cwd: runtime.workingDirectory,
        owner, signal: AbortSignal.timeout(20000), onNotification: () => {},
        register: async registration => { assertCodexOwnedProcessRegistration(registration, owner); },
      });
      try {
        await child.request('initialize', { clientInfo: { name: 'flujo_models', version: '1' } }, 10000);
        child.notify('initialized');
        const account = record(await child.request('account/read', { refreshToken: false }, 10000));
        if (record(account?.account)?.type !== 'chatgpt') throw new Error('Codex subscription login is unavailable');
        const rows: unknown[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = record(await child.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 10000));
          if (!Array.isArray(page?.data) || page.data.length > 100 || rows.length + page.data.length > MAX_MODELS) throw new Error('Invalid Codex catalogue');
          rows.push(...page.data);
          const next = page.nextCursor;
          if (next !== null && next !== undefined && (typeof next !== 'string' || !next || next.length > 4096 || cursors.has(next))) throw new Error('Invalid Codex catalogue cursor');
          cursor = typeof next === 'string' ? next : undefined;
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (await identity() !== before) throw new Error('Codex account changed during discovery');
        const models = normalizeCodexModels(rows);
        if (models.length) {
          // Short-lived account/version-scoped cache; removed models and new releases refresh automatically.
          if (caches.size >= 64) caches.clear();
          caches.set(key, { models, expires: Date.now() + 60_000 });
        }
        return models;
      } finally { await child.stop(); }
    })();
    pending.set(key, operation);
    try { return await operation; }
    finally { pending.delete(key); }
  } finally { await lease.release(); }
}
