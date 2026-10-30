'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ALLOWANCE_MAX_AGE_MS, isSubscriptionAllowance, type WorkspaceAllowance } from '@/shared/types/model/allowance';
import { getSelectedWorkspace, onWorkspaceChanged, withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import { ENCRYPTION_UNLOCKED_EVENT } from '@/frontend/utils/encryptionLock';
import { MODEL_CATALOG_CHANGED_EVENT } from '@/frontend/services/model';

/** How often an open allowance display re-reads the cached snapshot; well
 * inside ALLOWANCE_MAX_AGE_MS so a shown reading never silently expires. */
export const ALLOWANCE_REREAD_INTERVAL_MS = 2 * 60_000;
/** Minimum gap before focusing the window triggers another re-read. */
const ALLOWANCE_FOCUS_REREAD_MS = 60_000;

type Snapshot = WorkspaceAllowance & { entities?: { flows: Record<string, string[]>; personas: Record<string, string[]> } };
interface AllowanceContextValue {
  snapshot: Snapshot | null; loading: boolean; failed: boolean; now: number;
  refresh(modelIds?: string[]): Promise<void>; ensureFresh(modelIds?: string[]): Promise<void>; observe(): () => void;
}
const Context = createContext<AllowanceContextValue>({ snapshot: null, loading: false, failed: false, now: Date.now(), refresh: async () => {}, ensureFresh: async () => {}, observe: () => () => {} });
export const useAllowance = () => useContext(Context);

/** One snapshot serves every card. Visible subscription displays collect missing
 * readings and keep observing the cache, including observations made during runs. */
export function AllowanceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const observers = useRef(0);
  const lastCollection = useRef(new Map<string, number>());
  const current = useRef<{ workspace: string; controller: AbortController; pending: Promise<void>; refresh: boolean; modelIds?: string[] } | null>(null);
  const lastLoadAt = useRef(0);
  const load = useCallback(function request(workspace: string, refresh = false, modelIds?: string[], silent = false): Promise<void> {
    if (current.current?.workspace === workspace && !current.current.controller.signal.aborted) {
      // A click during the initial cached GET must still perform its requested check.
      const active = current.current;
      const coversSelection = !active.modelIds || (modelIds && modelIds.every(id => active.modelIds?.includes(id)));
      if (refresh && (!active.refresh || !coversSelection)) {
        return active.pending.then(() => getSelectedWorkspace() === workspace ? request(workspace, true, modelIds) : undefined);
      }
      return current.current.pending;
    }
    current.current?.controller.abort();
    const controller = new AbortController();
    lastLoadAt.current = Date.now();
    if (!silent) { setLoading(true); setFailed(false); }
    const pending = (async () => {
      try {
        const response = await fetch(withWorkspaceUrl('/api/model/allowance', workspace), {
          method: refresh ? 'POST' : 'GET', signal: controller.signal,
          ...(refresh && modelIds ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelIds }) } : {}),
        });
        if (!response.ok) throw new Error('Allowance snapshot unavailable');
        const data = await response.json() as Snapshot;
        if (!controller.signal.aborted && current.current?.controller === controller) { setNow(Date.now()); setSnapshot(data); }
      } catch {
        // A failed background re-read keeps the last good snapshot on screen.
        if (!silent && !controller.signal.aborted && current.current?.controller === controller) setFailed(true);
      } finally {
        if (!controller.signal.aborted && current.current?.controller === controller) { current.current = null; setLoading(false); }
      }
    })();
    current.current = { workspace, controller, pending, refresh, modelIds };
    return pending;
  }, []);
  useEffect(() => {
    void load(getSelectedWorkspace());
    const unsubscribe = onWorkspaceChanged(workspace => { current.current?.controller.abort(); setSnapshot(null); void load(workspace); });
    const unlocked = () => { void load(getSelectedWorkspace()); };
    const modelsChanged = () => {
      const workspace = getSelectedWorkspace();
      const active = current.current;
      lastCollection.current.clear();
      // Native collection owns a child until its pipes close. A bundle save
      // must not cancel it and immediately share the same draining task.
      if (active?.workspace === workspace && active.refresh && !active.controller.signal.aborted) {
        void active.pending.then(() => getSelectedWorkspace() === workspace ? load(workspace) : undefined);
        return;
      }
      active?.controller.abort();
      setSnapshot(null);
      void load(workspace);
    };
    window.addEventListener(ENCRYPTION_UNLOCKED_EVENT, unlocked);
    window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, modelsChanged);
    return () => { unsubscribe(); window.removeEventListener(ENCRYPTION_UNLOCKED_EVENT, unlocked); window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, modelsChanged); current.current?.controller.abort(); };
  }, [load]);
  const observe = useCallback(() => {
    observers.current += 1;
    return () => { observers.current -= 1; };
  }, []);
  useEffect(() => {
    // Background re-reads of the cached snapshot are silent and spaced out: the
    // bars used to flash "Checking…" every 30 s and on every window focus (#1278).
    const cached = () => {
      if (observers.current > 0 && document.visibilityState !== 'hidden'
        && Date.now() - lastLoadAt.current >= ALLOWANCE_FOCUS_REREAD_MS) void load(getSelectedWorkspace(), false, undefined, true);
    };
    const timer = setInterval(cached, ALLOWANCE_REREAD_INTERVAL_MS);
    window.addEventListener('focus', cached);
    document.addEventListener('visibilitychange', cached);
    return () => { clearInterval(timer); window.removeEventListener('focus', cached); document.removeEventListener('visibilitychange', cached); };
  }, [load]);
  useEffect(() => {
    const deadlines = (snapshot?.models ?? []).flatMap(row => [row.observedAt ? Date.parse(row.observedAt) + ALLOWANCE_MAX_AGE_MS : NaN, row.retryAt ? Date.parse(row.retryAt) : NaN, ...row.windows.map(window => window.resetAt ? Date.parse(window.resetAt) : NaN)]).filter(deadline => Number.isFinite(deadline) && deadline > now);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(...deadlines) - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [snapshot, now]);
  const accountKey = useCallback((workspace: string, row: Snapshot['models'][number]) => workspace + ':' + (row.accountGroup ?? row.modelId), []);
  const refresh = useCallback((modelIds?: string[]) => {
    const workspace = getSelectedWorkspace();
    const requested = snapshot?.models.filter(row => isSubscriptionAllowance(row) && (!modelIds || modelIds.includes(row.modelId))) ?? [];
    const keys = new Set(requested.map(row => accountKey(workspace, row)));
    for (const key of keys) lastCollection.current.set(key, Date.now());
    const sharedIds = snapshot?.models.filter(row => keys.has(accountKey(workspace, row))).map(row => row.modelId);
    return load(workspace, true, modelIds ? sharedIds : undefined);
  }, [load, snapshot, accountKey]);
  const ensureFresh = useCallback(async (modelIds?: string[]) => {
    const workspace = getSelectedWorkspace();
    // A usage-permission refusal is rechecked automatically once its retryAt passes.
    const missing = snapshot?.models.filter(row => isSubscriptionAllowance(row)
      && (!row.retryAt || Date.parse(row.retryAt) <= now)
      && (!modelIds || modelIds.includes(row.modelId))
      && Date.now() - (lastCollection.current.get(accountKey(workspace, row)) ?? 0) >= ALLOWANCE_MAX_AGE_MS
      && (row.status !== 'available' || !row.observedAt || now - Date.parse(row.observedAt) >= ALLOWANCE_MAX_AGE_MS
        || row.windows.some(window => window.resetAt && Date.parse(window.resetAt) <= now)));
    if (missing?.length) await refresh(missing.map(row => row.modelId));
  }, [snapshot, now, refresh, accountKey]);
  return <Context.Provider value={{ snapshot, loading, failed, now, refresh, observe, ensureFresh }}>{children}</Context.Provider>;
}
