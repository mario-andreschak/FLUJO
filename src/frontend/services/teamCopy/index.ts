import type { SharedItemKind } from '@/frontend/services/sharedItems';

/**
 * Browser side of "Copy to a team workspace" (#575). The server copies the
 * item without keys, passwords or sign-ins and answers what the person still
 * has to enter in the team workspace.
 */

export interface CopyTarget {
  readonly workspace: string;
  readonly ownerType: 'user' | 'team' | null;
  readonly teamName?: string;
  /** The person's own workspace. */
  readonly mine: boolean;
}

export interface CopyMissingValue {
  readonly field: string;
  readonly hint: string;
}

export interface CopyDependency {
  readonly kind: SharedItemKind;
  readonly id: string;
  readonly name: string;
}

export interface CopyResult {
  readonly copied: { readonly kind: SharedItemKind; readonly id: string; readonly name: string };
  readonly targetWorkspace: string;
  readonly missingValues: readonly CopyMissingValue[];
  readonly missingDependencies: readonly CopyDependency[];
}

export type CopyAnswer =
  | { readonly ok: true; readonly result: CopyResult }
  | { readonly ok: false; readonly error: string; readonly missingDependencies: readonly CopyDependency[] };

const UNREACHABLE = 'Could not reach FLUJO. Check that it is still running, then try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isKind(value: unknown): value is SharedItemKind {
  return value === 'flow' || value === 'model' || value === 'mcp-server';
}

function dependencies(value: unknown): CopyDependency[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => isRecord(item) && isKind(item.kind) && typeof item.id === 'string' && typeof item.name === 'string'
    ? [{ kind: item.kind, id: item.id, name: item.name }] : []);
}

function missingValues(value: unknown): CopyMissingValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => isRecord(item) && typeof item.field === 'string' && typeof item.hint === 'string'
    ? [{ field: item.field, hint: item.hint }] : []);
}

/** The workspaces the signed-in person may copy into. `null` while multi-user mode is off. */
export async function listCopyTargets(signal?: AbortSignal): Promise<CopyTarget[] | null> {
  const response = await fetch('/api/team-copy', {
    credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : UNREACHABLE);
  }
  if (!isRecord(body) || body.enabled !== true || !Array.isArray(body.targets)) return null;
  return body.targets.flatMap(item => isRecord(item) && typeof item.workspace === 'string'
    ? [{
      workspace: item.workspace,
      ownerType: item.ownerType === 'team' || item.ownerType === 'user' ? item.ownerType : null,
      ...(typeof item.teamName === 'string' ? { teamName: item.teamName } : {}),
      mine: item.mine === true,
    }]
    : []);
}

/** Copy one item into another workspace. */
export async function copyToWorkspace(kind: SharedItemKind, id: string, targetWorkspace: string): Promise<CopyAnswer> {
  let response: Response;
  try {
    response = await fetch('/api/team-copy', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id, targetWorkspace }),
    });
  } catch {
    return { ok: false, error: UNREACHABLE, missingDependencies: [] };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || !isRecord(body.copied)) {
    return {
      ok: false,
      error: isRecord(body) && typeof body.error === 'string' ? body.error : 'The copy did not work. Try again.',
      missingDependencies: isRecord(body) ? dependencies(body.missingDependencies) : [],
    };
  }
  const copied = body.copied;
  return {
    ok: true,
    result: {
      copied: {
        kind: isKind(copied.kind) ? copied.kind : kind,
        id: typeof copied.id === 'string' ? copied.id : id,
        name: typeof copied.name === 'string' ? copied.name : id,
      },
      targetWorkspace: typeof body.targetWorkspace === 'string' ? body.targetWorkspace : targetWorkspace,
      missingValues: missingValues(body.missingValues),
      missingDependencies: dependencies(body.missingDependencies),
    },
  };
}
