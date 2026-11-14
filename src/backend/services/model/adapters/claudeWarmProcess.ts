import { createHash } from 'node:crypto';
import os from 'node:os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  HookCallback, Options, PermissionResult, Query, SDKUserMessage, SpareProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';

/**
 * Prewarmed Claude Code processes for the Claude subscription adapter (#1408).
 *
 * Every Claude subscription request used to start a new Claude Code process.
 * With the token passed in the environment, that start-up includes network
 * calls (usage policy, remote settings) before the process is ready: about
 * 1.6 s on a Windows dev machine, before the model is even asked.
 *
 * When enabled (`experimental.claudeWarmProcess`, or FLUJO_CLAUDE_WARM_PROCESS=1),
 * a finished request leaves one parked spare process for its exact request
 * shape: model, system prompt, tool definitions, options and environment
 * (which carries the account's token and the workspace's private Claude
 * home). The next request with the same shape claims it with the Agent SDK's
 * `prewarm()`/`claim()` and skips the start-up.
 *
 * Isolation: a spare serves exactly one request and then exits, so no history
 * or session state carries over. Its callbacks (tool handlers, PreToolUse
 * hook, canUseTool) are bound at claim time to the claiming request's own
 * handlers; before a claim and after the request they deny everything. A spare
 * is only ever claimed by a request whose key matches, so the account,
 * workspace home and tool set are the ones it was started with.
 *
 * Resilience: a spare that dies, is refused or is too slow to claim is simply
 * dropped and the request starts Claude Code as before. Spares idle for
 * CLAUDE_WARM_IDLE_MS are closed, and the total is bounded by the machine's
 * memory (each parked process holds about 250 MB).
 */

const log = createLogger('backend/services/model/adapters/claudeWarmProcess');

export type ClaudeSpareToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
type ToolHandler = ClaudeSpareToolHandler;
type CanUseTool = NonNullable<Options['canUseTool']>;

export interface ClaudeSpareBinding {
  canUseTool: CanUseTool;
  preToolUse: HookCallback;
  tools: ReadonlyMap<string, ToolHandler>;
}

interface Spare {
  readonly key: string;
  /** Hashes of each part of the shape, and of each environment value, for diagnostics. */
  readonly parts: Readonly<Record<string, string>>;
  readonly ready: Promise<SpareProcess | undefined>;
  readonly abortController: AbortController;
  readonly binding: { current?: ClaudeSpareBinding };
  idleTimer?: ReturnType<typeof setTimeout>;
  taken: boolean;
}

const CLAUDE_WARM_IDLE_MS = 10 * 60_000;
const CLAIM_TIMEOUT_MS = 10_000;
const PARKED_PROCESS_BYTES = 256 * 1024 * 1024;

declare global {
  var __flujoClaudeSpares: Map<string, Spare> | undefined;
}
const spares = globalThis.__flujoClaudeSpares ??= new Map<string, Spare>();

/** Opt-in: the experimental setting, or FLUJO_CLAUDE_WARM_PROCESS for headless installs. */
export async function isClaudeWarmProcessEnabled(): Promise<boolean> {
  const configured = process.env.FLUJO_CLAUDE_WARM_PROCESS?.trim();
  if (configured) return configured === '1' || configured.toLowerCase() === 'true';
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    return settings?.experimental?.claudeWarmProcess === true;
  } catch (error) {
    log.warn('Could not read the Claude warm process setting; starting Claude Code per request', error);
    return false;
  }
}

/** One parked spare per 2 GiB of memory, between 1 and 4. */
export function maxClaudeSpares(totalMemory = os.totalmem()): number {
  return Math.max(1, Math.min(4, Math.floor(totalMemory / (8 * PARKED_PROCESS_BYTES))));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && typeof entry !== 'function')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/** Everything a spare is started with, as one opaque key. */
export function claudeSpareKey(shape: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(shape))).digest('hex');
}

/** One hash per part of the shape; `env` is split into one hash per variable. */
function shapeParts(shape: Record<string, unknown>): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const [name, value] of Object.entries(shape)) {
    if (name === 'env' && value && typeof value === 'object') {
      for (const [variable, setting] of Object.entries(value as Record<string, unknown>)) {
        if (setting !== undefined) parts[`env.${variable}`] = claudeSpareKey(setting);
      }
    } else parts[name] = claudeSpareKey(value);
  }
  return parts;
}

/**
 * Why no parked process matched this shape: the names (never the values) of
 * the parts that differ from the closest parked one. Empty when none is parked.
 */
export function explainClaudeSpareMiss(shape: Record<string, unknown>): string[] {
  const wanted = shapeParts(shape);
  let closest: string[] | undefined;
  for (const spare of spares.values()) {
    const names = new Set([...Object.keys(wanted), ...Object.keys(spare.parts)]);
    const differing = [...names].filter(name => wanted[name] !== spare.parts[name]).sort();
    if (!closest || differing.length < closest.length) closest = differing;
  }
  return closest ?? [];
}

function closeSpare(spare: Spare): void {
  if (spares.get(spare.key) === spare) spares.delete(spare.key);
  if (spare.idleTimer) clearTimeout(spare.idleTimer);
  spare.binding.current = undefined;
  spare.abortController.abort();
  void spare.ready.then(process => process?.close(), () => undefined);
}

/** Close every parked spare, for example when the setting is turned off. */
export function closeAllClaudeSpares(): void {
  for (const spare of [...spares.values()]) closeSpare(spare);
}

/** Take the spare for this request shape, if one was prepared. */
export function takeClaudeSpare(shape: Record<string, unknown>): Spare | undefined {
  const key = claudeSpareKey(shape);
  const spare = spares.get(key);
  if (!spare || spare.taken) return undefined;
  spare.taken = true;
  spares.delete(key);
  if (spare.idleTimer) clearTimeout(spare.idleTimer);
  return spare;
}

/**
 * Bind a spare to this request and send its prompt once the process accepted
 * the claim. Returns undefined when the spare cannot serve the request; the
 * caller then starts Claude Code as before. The prompt is held until the claim
 * is accepted, so a refused spare never receives it.
 */
export async function claimClaudeSpare(spare: Spare, params: {
  prompt: () => AsyncIterable<SDKUserMessage>;
  cwd: string;
  binding: ClaudeSpareBinding;
  signal: AbortSignal;
}): Promise<Query | undefined> {
  const deadline = Date.now() + CLAIM_TIMEOUT_MS;
  // Wait until the deadline, or until the request is stopped.
  const within = <T>(promise: Promise<T>, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onStop: (() => void) | undefined;
    return Promise.race([
      promise,
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now()));
        onStop = () => resolve(fallback);
        params.signal.addEventListener('abort', onStop, { once: true });
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      if (onStop) params.signal.removeEventListener('abort', onStop);
    });
  };
  // A spare still starting is waited for: it began before this request did.
  const spareProcess = await within(spare.ready.catch(() => undefined), undefined);
  if (!spareProcess || params.signal.aborted) {
    closeSpare(spare);
    return undefined;
  }
  spare.binding.current = params.binding;
  const onAbort = () => spare.abortController.abort();
  params.signal.addEventListener('abort', onAbort, { once: true });
  let openGate!: (accepted: boolean) => void;
  const gate = new Promise<boolean>(resolve => { openGate = resolve; });
  const prompt = params.prompt;
  async function* gatedPrompt(): AsyncGenerator<SDKUserMessage> {
    if (!await gate) return;
    yield* prompt();
  }
  let query: Query;
  try {
    // The token and the private Claude home were given at start-up (they are
    // part of the key), so the claim only names the working folder.
    query = spareProcess.claim({ prompt: gatedPrompt(), options: { cwd: params.cwd } });
  } catch (error) {
    log.warn('Claude spare could not be claimed; starting Claude Code', error);
    params.signal.removeEventListener('abort', onAbort);
    closeSpare(spare);
    return undefined;
  }
  const accepted = await within(spareProcess.claimed.then(() => true, (error: unknown) => {
    log.warn('Claude spare refused the claim; starting Claude Code', { reason: error instanceof Error ? error.message : String(error) });
    return false;
  }), false);
  openGate(accepted);
  if (!accepted) {
    params.signal.removeEventListener('abort', onAbort);
    closeSpare(spare);
    return undefined;
  }
  return query;
}

/** Unbind a claimed spare from its request once the request is over. */
export function releaseClaudeSpare(spare: Spare): void {
  spare.binding.current = undefined;
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

/**
 * Park a spare for this request shape unless one exists. `makeOptions` builds
 * the exact options a cold request would use, with the given delegating
 * callbacks in place of the request's own. Never throws.
 */
export function prepareClaudeSpare(params: {
  shape: Record<string, unknown>;
  sdk: Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'prewarm'>;
  makeOptions: (delegates: {
    abortController: AbortController;
    canUseTool: CanUseTool;
    preToolUse: HookCallback;
    toolHandler: (name: string) => ToolHandler;
  }) => Options;
}): void {
  const key = claudeSpareKey(params.shape);
  if (spares.has(key)) return;
  while (spares.size >= maxClaudeSpares()) {
    const oldest = spares.values().next().value as Spare | undefined;
    if (!oldest) break;
    closeSpare(oldest);
  }
  const abortController = new AbortController();
  const binding: Spare['binding'] = {};
  const unbound = 'No request owns this Claude process.';
  let options: Options;
  try {
    options = params.makeOptions({
      abortController,
      canUseTool: (name, input, opts) => binding.current
        ? binding.current.canUseTool(name, input, opts) : Promise.resolve(deny(unbound)),
      preToolUse: (input, toolUseId, opts) => binding.current
        ? binding.current.preToolUse(input, toolUseId, opts)
        : Promise.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const, permissionDecisionReason: unbound } }),
      toolHandler: name => (args, extra) => {
        const handler = binding.current?.tools.get(name);
        return handler ? handler(args, extra)
          : Promise.resolve({ content: [{ type: 'text', text: unbound }], isError: true });
      },
    });
  } catch (error) {
    log.warn('Could not prepare a Claude spare', error);
    return;
  }
  const ready = Promise.resolve().then(() => params.sdk.prewarm({ options })).catch((error: unknown) => {
    log.warn('Claude spare failed to start', { reason: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
  const spare: Spare = { key, parts: shapeParts(params.shape), ready, abortController, binding, taken: false };
  spares.set(key, spare);
  spare.idleTimer = setTimeout(() => closeSpare(spare), CLAUDE_WARM_IDLE_MS);
  spare.idleTimer.unref?.();
  void ready.then(process => {
    if (!process) { closeSpare(spare); return; }
    // A parked spare that dies is replaced by the next request, not reused.
    void process.exited.then(() => { if (!spare.taken) closeSpare(spare); });
  });
}

/** Test seam: the number of parked spares. */
export function _claudeSpareCountForTests(): number {
  return spares.size;
}
