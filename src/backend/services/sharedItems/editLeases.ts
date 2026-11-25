import type { SharedItemKind } from './kinds';

/**
 * "Anna is editing" notes (#575, step 575-2). An editor that opens a flow,
 * model or MCP server takes a short lease and renews it while it stays open.
 * The lease only informs: it never blocks a save. The real guard against lost
 * changes is the version check on save (`guard.ts`).
 *
 * Leases live in memory only. Each ends by itself
 * {@link EDIT_LEASE_MS} after its last renewal (a closed browser simply stops
 * renewing), when its person releases it, when the team's generation changes
 * (someone was removed or got another role), or at a restart. Nothing here can
 * stay stuck.
 */

export const EDIT_LEASE_MS = 60_000;
/** Editors renew this often, so two missed renewals still keep the lease. */
export const EDIT_LEASE_RENEW_MS = 20_000;
const SWEEP_EVERY_MS = 30_000;

export interface EditLeaseHolder {
  readonly userId: string;
  readonly name: string;
  /** When this person started editing (kept across renewals). */
  readonly since: number;
  readonly expiresAt: number;
}

interface StoredLease extends EditLeaseHolder {
  /** The owning team's generation when taken; 0 for a personal workspace. */
  readonly generation: number;
}

interface LeaseGlobals {
  leases: Map<string, Map<string, StoredLease>>;
  lastSweep: number;
}

declare global {
  var __flujo_edit_leases: LeaseGlobals | undefined;
}

function globals(): LeaseGlobals {
  global.__flujo_edit_leases ??= { leases: new Map(), lastSweep: 0 };
  return global.__flujo_edit_leases;
}

function keyOf(workspace: string, kind: SharedItemKind, itemId: string): string {
  return `${workspace}\u0000${kind}\u0000${itemId}`;
}

/** Drop every lease that ran out. Runs at most every 30 seconds, so the map never grows without bound. */
function sweep(now: number): void {
  const shared = globals();
  if (now - shared.lastSweep < SWEEP_EVERY_MS) return;
  shared.lastSweep = now;
  for (const [key, holders] of shared.leases) {
    for (const [userId, lease] of holders) if (lease.expiresAt <= now) holders.delete(userId);
    if (holders.size === 0) shared.leases.delete(key);
  }
}

export interface LeaseRequest {
  readonly workspace: string;
  readonly kind: SharedItemKind;
  readonly itemId: string;
  readonly userId: string;
  readonly name: string;
  readonly generation: number;
}

/** Leases of other people that still count: not expired and taken under the current team generation. */
function liveOthers(holders: Map<string, StoredLease> | undefined, userId: string | null, generation: number,
  now: number): EditLeaseHolder[] {
  if (!holders) return [];
  const others: EditLeaseHolder[] = [];
  for (const [holderId, lease] of holders) {
    if (lease.expiresAt <= now || lease.generation !== generation) {
      holders.delete(holderId);
      continue;
    }
    if (holderId !== userId) {
      others.push({ userId: lease.userId, name: lease.name, since: lease.since, expiresAt: lease.expiresAt });
    }
  }
  return others.sort((a, b) => a.since - b.since);
}

/** Take or renew this person's lease. Returns it and the other people editing the same item. */
export function takeEditLease(request: LeaseRequest, now = Date.now()): { lease: EditLeaseHolder; others: EditLeaseHolder[] } {
  sweep(now);
  const shared = globals();
  const key = keyOf(request.workspace, request.kind, request.itemId);
  let holders = shared.leases.get(key);
  if (!holders) {
    holders = new Map();
    shared.leases.set(key, holders);
  }
  const others = liveOthers(holders, request.userId, request.generation, now);
  const previous = holders.get(request.userId);
  const lease: StoredLease = {
    userId: request.userId,
    name: request.name,
    since: previous && previous.generation === request.generation ? previous.since : now,
    expiresAt: now + EDIT_LEASE_MS,
    generation: request.generation,
  };
  holders.set(request.userId, lease);
  return { lease: { userId: lease.userId, name: lease.name, since: lease.since, expiresAt: lease.expiresAt }, others };
}

/** Who else is editing, without taking a lease (for people who only look). */
export function otherEditors(workspace: string, kind: SharedItemKind, itemId: string, userId: string | null,
  generation: number, now = Date.now()): EditLeaseHolder[] {
  sweep(now);
  const shared = globals();
  const key = keyOf(workspace, kind, itemId);
  const holders = shared.leases.get(key);
  const others = liveOthers(holders, userId, generation, now);
  if (holders && holders.size === 0) shared.leases.delete(key);
  return others;
}

/** The person closed the editor. */
export function releaseEditLease(workspace: string, kind: SharedItemKind, itemId: string, userId: string): void {
  const shared = globals();
  const key = keyOf(workspace, kind, itemId);
  const holders = shared.leases.get(key);
  if (!holders) return;
  holders.delete(userId);
  if (holders.size === 0) shared.leases.delete(key);
}

/** Forget every lease (tests). */
export function resetEditLeases(): void {
  globals().leases.clear();
  globals().lastSweep = 0;
}
