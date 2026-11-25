import { DEFAULT_WORKSPACE, isValidWorkspaceName } from '@/frontend/utils/workspaceSelection';

/** How long discovery keeps retrying slow or failing answers before it shows an error (AGENTS.md: resilience over refusal). */
export const DISCOVERY_PATIENCE_MS = 60_000;
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 5_000;

interface DiscoveryResponse {
  ok: boolean;
  status: number;
  headers?: { get?: (name: string) => string | null };
  json: () => Promise<unknown>;
}

export type DiscoveryOutcome =
  | { kind: 'ready'; names: Set<string> }
  | { kind: 'owner-auth' }
  /** Multi-user mode is on and this browser is not signed in. */
  | { kind: 'account-sign-in' }
  /** Multi-user mode is on but the accounts file on the server is damaged; `message` is the server's plain answer. */
  | { kind: 'accounts-damaged'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'cancelled' };

export interface DiscoveryOptions {
  request?: () => Promise<DiscoveryResponse>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  patienceMs?: number;
  isCancelled?: () => boolean;
  /** The server is migrating the workspace layout; it tells us when to ask again. */
  onMigrating?: () => void;
  /** An answer failed; discovery keeps trying until `patienceMs` has passed without success. */
  onSlow?: () => void;
}

export function pauseAfterFailure(failures: number): number {
  return Math.min(FIRST_PAUSE_MS * 2 ** Math.max(0, failures - 1), LONGEST_PAUSE_MS);
}

async function readPayload(response: DiscoveryResponse): Promise<{ workspaces?: Array<{ name?: unknown }>; code?: unknown; error?: unknown } | null> {
  try {
    const payload: unknown = await response.json();
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * The workspace to open when the remembered one is not in the list: the
 * default workspace when this person has it, otherwise the first one listed.
 * `null` when they have none (possible in multi-user mode).
 */
export function fallbackWorkspace(names: ReadonlySet<string>): string | null {
  if (names.has(DEFAULT_WORKSPACE)) return DEFAULT_WORKSPACE;
  for (const name of names) return name;
  return null;
}

function retryAfterMs(response: DiscoveryResponse): number {
  const header = response.headers?.get?.('Retry-After');
  const seconds = header ? Number(header) : Number.NaN;
  return Number.isFinite(seconds) ? Math.max(500, seconds * 1000) : 2000;
}

/** Asks the server which workspaces exist, waiting through slow starts and migrations. */
export async function discoverWorkspaces({
  request = () => fetch('/api/workspaces', { cache: 'no-store' }),
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now = Date.now,
  patienceMs = DISCOVERY_PATIENCE_MS,
  isCancelled = () => false,
  onMigrating,
  onSlow,
}: DiscoveryOptions = {}): Promise<DiscoveryOutcome> {
  let failures = 0;
  let failingSince: number | undefined;
  while (!isCancelled()) {
    try {
      const response = await request();
      if (response.status === 401) {
        const denial = await readPayload(response);
        return denial?.code === 'ACCOUNT_SIGN_IN_REQUIRED' ? { kind: 'account-sign-in' } : { kind: 'owner-auth' };
      }
      const payload = await readPayload(response);
      if (response.status === 503 && payload?.code === 'ACCOUNTS_DAMAGED') {
        return {
          kind: 'accounts-damaged',
          message: typeof payload.error === 'string' && payload.error
            ? payload.error
            : 'Sign-in is unavailable because the accounts file on the server is damaged. An admin must fix it on the server.',
        };
      }
      if (response.status === 503 && payload?.code === 'WORKSPACE_LAYOUT_PREPARING') {
        failures = 0;
        failingSince = undefined;
        onMigrating?.();
        await wait(retryAfterMs(response));
        continue;
      }
      if (!response.ok || !payload) throw new Error(`Workspace discovery failed (${response.status})`);
      const names = (Array.isArray(payload.workspaces) ? payload.workspaces : [])
        .map((item) => item?.name)
        .filter(isValidWorkspaceName);
      return { kind: 'ready', names: new Set(names) };
    } catch {
      failures += 1;
      failingSince ??= now();
      if (now() - failingSince >= patienceMs) return { kind: 'unavailable' };
      onSlow?.();
      await wait(pauseAfterFailure(failures));
    }
  }
  return { kind: 'cancelled' };
}
