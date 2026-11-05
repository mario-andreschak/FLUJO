/**
 * "Is this instance really usable?", asked of the running server.
 *
 * Costs nothing: no model is called, no MCP server is started, no flow runs. A
 * model or remote MCP host is only checked for whether it answers at all, with no
 * credentials sent. The report holds counts, names and host names, never a key, a
 * header, a query string or a raw error message.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROVIDER_INFO, supportsLocalModelAuth, type ModelProvider } from '@/shared/types/model/provider';

export type SelftestStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface SelftestCheck {
  id: string;
  status: SelftestStatus;
  /** Plain code, safe to log. Never contains data from the checked system. */
  reason?: string;
  count?: number;
  items?: SelftestItem[];
}

export interface SelftestItem {
  name: string;
  status: SelftestStatus;
  reason?: string;
  host?: string;
}

export interface SelftestReport {
  format: 'flujo-selftest';
  version: 1;
  collectedAt: string;
  workspace: string;
  usable: boolean;
  checks: SelftestCheck[];
}

export interface SelftestModel {
  name: string;
  displayName?: string;
  baseUrl?: string;
  provider?: string;
  adapter?: string;
}

export interface SelftestServer {
  name: string;
  disabled?: boolean;
  transport?: string;
  serverUrl?: string;
}

export interface SelftestSources {
  workspace: string;
  dataDirectory: string;
  writeFileAtomic: (file: string, data: string) => Promise<void>;
  loadFlows: () => Promise<readonly unknown[]>;
  loadModels: () => Promise<readonly SelftestModel[]>;
  loadServers: () => Promise<readonly SelftestServer[]>;
  runtimeStates: () => ReadonlyMap<string, string>;
  scheduler: () => Promise<{ enabled: number; armed: number; paused: boolean; started: boolean }>;
  /** False when asked not to touch the network. */
  network: boolean;
  /** Tests replace this; everything else is the real thing. */
  reach?: (origin: string) => Promise<boolean>;
}

const REACH_TIMEOUT_MS = 5_000;
/** A larger installation is still checked, just not host by host forever. */
const MAX_HOSTS = 25;
const MAX_ITEMS = 200;

/** Any HTTP answer counts, including 401 or 404: the host is there. No credentials. */
async function reachOrigin(origin: string): Promise<boolean> {
  try {
    await fetch(origin, { method: 'HEAD', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
    return true;
  } catch { return false; }
}

/** Origin only: a stored URL can carry a key in its user part or query. */
export function safeOrigin(value: string | undefined): { origin: string; host: string } | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { origin: parsed.origin, host: parsed.host };
  } catch { return null; }
}

function modelEndpoint(model: SelftestModel): string | undefined {
  if (model.baseUrl?.trim()) return model.baseUrl;
  const provider = model.provider as ModelProvider | undefined;
  return provider ? PROVIDER_INFO[provider]?.baseUrl : undefined;
}

class HostChecker {
  private readonly results = new Map<string, Promise<boolean>>();
  constructor(private readonly reach: (origin: string) => Promise<boolean>) {}
  get full(): boolean { return this.results.size >= MAX_HOSTS; }
  has(origin: string): boolean { return this.results.has(origin); }
  check(origin: string): Promise<boolean> {
    let result = this.results.get(origin);
    if (!result) {
      result = this.reach(origin).catch(() => false);
      this.results.set(origin, result);
    }
    return result;
  }
}

async function storageCheck(source: SelftestSources): Promise<SelftestCheck> {
  const probeDirectory = path.join(source.dataDirectory, 'db');
  const probe = path.join(probeDirectory, `.selftest-${randomUUID()}.tmp`);
  const content = randomUUID();
  try {
    await fs.mkdir(probeDirectory, { recursive: true });
    await source.writeFileAtomic(probe, content);
    const read = await fs.readFile(probe, 'utf8');
    return read === content ? { id: 'storage', status: 'ok' } : { id: 'storage', status: 'fail', reason: 'read-back-differs' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { id: 'storage', status: 'fail', reason: code === 'ENOSPC' ? 'disk-full' : code === 'EACCES' || code === 'EPERM' ? 'not-allowed' : 'not-writable' };
  } finally {
    await fs.rm(probe, { force: true }).catch(() => undefined);
  }
}

async function flowsCheck(source: SelftestSources): Promise<SelftestCheck> {
  try {
    const flows = await source.loadFlows();
    return { id: 'flows', status: 'ok', count: flows.length };
  } catch { return { id: 'flows', status: 'fail', reason: 'flows-did-not-load' }; }
}

async function itemFromHost(name: string, url: string | undefined, hosts: HostChecker, network: boolean): Promise<SelftestItem> {
  const target = safeOrigin(url);
  if (!target) return { name, status: 'skipped', reason: 'no-address' };
  if (!network) return { name, status: 'skipped', reason: 'network-check-off', host: target.host };
  if (hosts.full && !hosts.has(target.origin)) return { name, status: 'skipped', reason: 'too-many-hosts', host: target.host };
  return await hosts.check(target.origin)
    ? { name, status: 'ok', host: target.host }
    : { name, status: 'warn', reason: 'not-reachable', host: target.host };
}

function summarized(id: string, items: SelftestItem[]): SelftestCheck {
  return {
    id,
    status: items.some(item => item.status === 'warn') ? 'warn' : 'ok',
    count: items.length,
    items: items.slice(0, MAX_ITEMS),
  };
}

async function modelsCheck(source: SelftestSources, hosts: HostChecker): Promise<SelftestCheck> {
  let models: readonly SelftestModel[];
  try { models = await source.loadModels(); }
  catch { return { id: 'models', status: 'fail', reason: 'models-did-not-load' }; }
  const items = await Promise.all(models.map(async (model): Promise<SelftestItem> => {
    const name = model.displayName || model.name;
    // These run on this PC through their own login: there is no address to try.
    if (supportsLocalModelAuth(model.adapter) || model.adapter === 'claude-cli') return { name, status: 'skipped', reason: 'local-sign-in' };
    return itemFromHost(name, modelEndpoint(model), hosts, source.network);
  }));
  return summarized('models', items);
}

async function serversCheck(source: SelftestSources, hosts: HostChecker): Promise<SelftestCheck> {
  let servers: readonly SelftestServer[];
  try { servers = await source.loadServers(); }
  catch { return { id: 'mcp', status: 'fail', reason: 'mcp-config-did-not-load' }; }
  const states = source.runtimeStates();
  const items = await Promise.all(servers.map(async (server): Promise<SelftestItem> => {
    if (server.disabled) return { name: server.name, status: 'skipped', reason: 'switched-off' };
    const state = states.get(server.name);
    if (state === 'error') return { name: server.name, status: 'warn', reason: 'last-start-failed' };
    if (server.transport === 'sse' || server.transport === 'streamable' || server.transport === 'websocket') {
      const url = server.serverUrl?.replace(/^ws/i, 'http');
      return itemFromHost(server.name, url, hosts, source.network);
    }
    // A local server starts when first needed. Starting one here would change the
    // thing being looked at, so report what it is doing now.
    return { name: server.name, status: state === 'warm' ? 'ok' : 'skipped', reason: state === 'warm' ? undefined : `state-${state ?? 'cold'}` };
  }));
  return summarized('mcp', items);
}

async function schedulerCheck(source: SelftestSources): Promise<SelftestCheck> {
  try {
    const scheduler = await source.scheduler();
    if (scheduler.paused) return { id: 'schedules', status: 'warn', reason: 'paused', count: scheduler.enabled };
    if (scheduler.enabled > 0 && !scheduler.started) return { id: 'schedules', status: 'warn', reason: 'not-started', count: scheduler.enabled };
    return { id: 'schedules', status: 'ok', count: scheduler.enabled };
  } catch { return { id: 'schedules', status: 'warn', reason: 'not-readable' }; }
}

/** Storage and flows decide "usable". Models and MCP are reported, and fail only in strict mode. */
export async function runSelftest(source: SelftestSources): Promise<SelftestReport> {
  const hosts = new HostChecker(source.reach ?? reachOrigin);
  const [storage, flows, models, mcp, schedules] = await Promise.all([
    storageCheck(source), flowsCheck(source), modelsCheck(source, hosts), serversCheck(source, hosts), schedulerCheck(source),
  ]);
  const checks = [storage, flows, models, mcp, schedules];
  return {
    format: 'flujo-selftest',
    version: 1,
    collectedAt: new Date().toISOString(),
    workspace: source.workspace,
    usable: checks.every(check => check.status !== 'fail'),
    checks,
  };
}
