import fs from 'node:fs';
import { createLogger } from '../../../utils/logger';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { currentAccessActor, type AccessActor } from './accessContext';

const log = createLogger('backend/services/security/accessAudit');

/**
 * A bounded record of who did what, with no content in it.
 *
 * It holds an action name, an actor, a target id and an outcome. It never holds a
 * secret, a URL, a query string, a message, a prompt or a tool argument. It lives
 * beside the policy file, outside the workspace, so it is not exported with one.
 *
 * Two files at most: the current one rolls over to `.1` at the size limit, which
 * replaces the older `.1`. A failed write is logged and shown on the people page.
 * It never blocks a login or an approval, because the instance must keep working.
 */
export type AccessAuditAction =
  | 'login' | 'logout' | 'access.enable'
  | 'person.create' | 'person.update' | 'person.revoke'
  | 'flow.create' | 'flow.update' | 'flow.delete'
  | 'approval.decide' | 'access.denied' | 'access.recover';

export interface AccessAuditEntry {
  readonly at: number;
  readonly action: AccessAuditAction;
  readonly outcome: 'ok' | 'denied' | 'failed';
  readonly actor?: { readonly credentialId: string; readonly name?: string; readonly endUser?: string; readonly via?: string };
  readonly target?: string;
  readonly detail?: string;
  readonly workspace?: string;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_FIELD_LENGTH = 200;
const MAX_READ_LIMIT = 500;

const runtime = globalThis as typeof globalThis & {
  __flujoAccessAudit?: { tail: Promise<void>; lastWriteFailed: boolean };
};
const state = runtime.__flujoAccessAudit ??= { tail: Promise.resolve(), lastWriteFailed: false };

function maxBytes(): number {
  const configured = Number(process.env.FLUJO_ACCESS_AUDIT_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured >= 1024 ? configured : DEFAULT_MAX_BYTES;
}

function auditFile(): string | null {
  const policy = process.env.FLUJO_OWNER_AUTH_FILE?.trim();
  return policy ? `${policy}.audit.jsonl` : null;
}

/** One line per entry, whatever the value holds. */
function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return clean.length > MAX_FIELD_LENGTH ? `${clean.slice(0, MAX_FIELD_LENGTH)}...` : clean;
}

function actorOf(actor: AccessActor | undefined): AccessAuditEntry['actor'] {
  if (!actor) return undefined;
  return {
    credentialId: actor.credentialId,
    ...(actor.name ? { name: bounded(actor.name) } : {}),
    ...(actor.endUser ? { endUser: bounded(actor.endUser) } : {}),
    via: actor.via,
  };
}

async function append(file: string, line: string): Promise<void> {
  try {
    const stat = await fs.promises.stat(file).catch(() => null);
    if (stat && stat.size + line.length > maxBytes()) {
      await fs.promises.rename(file, `${file}.1`).catch(async error => {
        // Windows may refuse while another reader holds the file. Keep the record
        // growing a little rather than losing it; the next write tries again.
        log.warn('Could not roll over the access record', { code: (error as NodeJS.ErrnoException).code });
      });
    }
    await fs.promises.appendFile(file, line, { mode: 0o600 });
    state.lastWriteFailed = false;
  } catch (error) {
    state.lastWriteFailed = true;
    log.warn('Could not write the access record', { code: (error as NodeJS.ErrnoException).code });
  }
}

/** Queue one entry. Order is kept and the caller is never held up or failed by it. */
export function recordAccessEvent(event: {
  action: AccessAuditAction;
  outcome?: AccessAuditEntry['outcome'];
  actor?: AccessActor;
  target?: string;
  detail?: string;
  workspace?: string;
}): void {
  const file = auditFile();
  if (!file) return;
  const acting = event.actor ?? currentAccessActor();
  const actor = actorOf(acting);
  const workspace = event.workspace ?? acting?.workspaceId;
  const entry: AccessAuditEntry = {
    at: Date.now(), action: event.action, outcome: event.outcome ?? 'ok',
    ...(actor ? { actor } : {}),
    ...(event.target === undefined ? {} : { target: bounded(event.target) }),
    ...(event.detail === undefined ? {} : { detail: bounded(event.detail) }),
    ...(workspace === undefined ? {} : { workspace: bounded(workspace) }),
  };
  const line = `${JSON.stringify(entry)}\n`;
  state.tail = state.tail.then(() => append(file, line));
}

/** A no-op unless a named person made this change. */
export function recordFlowChange(action: 'flow.create' | 'flow.update' | 'flow.delete', flowId: string): void {
  const actor = currentAccessActor();
  if (!actor) return;
  recordAccessEvent({ action, actor, target: flowId, workspace: getCurrentWorkspace() });
}

/** Tests and shutdown can wait for queued entries. */
export function flushAccessEvents(): Promise<void> {
  return state.tail;
}

export function accessRecordWritable(): boolean {
  return !state.lastWriteFailed;
}

async function readEntries(file: string): Promise<AccessAuditEntry[]> {
  let text: string;
  try { text = await fs.promises.readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: AccessAuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as AccessAuditEntry;
      if (parsed && typeof parsed.at === 'number' && typeof parsed.action === 'string') entries.push(parsed);
    } catch { /* A torn last line after a crash must not hide the rest. */ }
  }
  return entries;
}

/** Newest first. A reader bound to one workspace sees only entries for that workspace. */
export async function readAccessEvents(options: {
  limit?: number; before?: number; action?: string; workspaceId?: string;
} = {}): Promise<{ entries: AccessAuditEntry[]; truncated: boolean }> {
  const file = auditFile();
  if (!file) return { entries: [], truncated: false };
  await flushAccessEvents();
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 100)), MAX_READ_LIMIT);
  const all = [...await readEntries(`${file}.1`), ...await readEntries(file)];
  const matching = all.filter(entry => (options.before === undefined || entry.at < options.before)
    && (options.action === undefined || entry.action === options.action)
    && (options.workspaceId === undefined || entry.workspace === options.workspaceId));
  matching.reverse();
  return { entries: matching.slice(0, limit), truncated: matching.length > limit };
}
