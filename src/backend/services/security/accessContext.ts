import { AsyncLocalStorage } from 'node:async_hooks';
import { hasAdminPair, seesEveryRun, type OwnerScope } from '../../../shared/types/access';
import type { OwnerPrincipal } from './ownerCredentials';

/**
 * Who is calling, for the length of one request, while named access is on.
 *
 * It is undefined on an ordinary install and on a schema 1 policy, so every
 * caller of `currentAccessActor` keeps its old behaviour unless the feature is on.
 *
 * Read it only at the request's own boundary (route handlers) and pass values on
 * explicitly. Background work started during a request inherits this context, so
 * a scheduler that first wakes inside a request must never read an owner from it.
 */
export interface AccessActor {
  readonly credentialId: string;
  readonly name?: string;
  readonly scopes: readonly OwnerScope[];
  readonly workspaceId?: string;
  readonly flowIds?: readonly string[];
  readonly isAdmin: boolean;
  readonly seesAll: boolean;
  readonly endUser?: string;
  readonly via: 'bearer' | 'session';
}

/** Who started a conversation. Kept on the conversation itself and never changed afterwards. */
export interface AccessOwner {
  credentialId: string;
  endUser?: string;
}

const runtime = globalThis as typeof globalThis & { __flujoAccessActor?: AsyncLocalStorage<AccessActor> };
const storage = runtime.__flujoAccessActor ??= new AsyncLocalStorage<AccessActor>();

export function accessActorFromPrincipal(
  principal: OwnerPrincipal & { readonly via?: 'bearer' | 'session' },
  endUser?: string,
): AccessActor | undefined {
  if (!principal.named) return undefined;
  return Object.freeze({
    credentialId: principal.credentialId,
    ...(principal.name === undefined ? {} : { name: principal.name }),
    scopes: principal.scopes,
    ...(principal.workspaceId === undefined ? {} : { workspaceId: principal.workspaceId }),
    ...(principal.flowIds === undefined ? {} : { flowIds: principal.flowIds }),
    isAdmin: hasAdminPair(principal.scopes),
    seesAll: seesEveryRun(principal.scopes),
    ...(endUser === undefined ? {} : { endUser }),
    via: principal.via ?? 'bearer',
  });
}

export function runWithAccessActor<T>(actor: AccessActor, run: () => T): T {
  return storage.run(actor, run);
}

export function currentAccessActor(): AccessActor | undefined {
  return storage.getStore();
}

export function accessOwnerFor(actor: AccessActor, endUser: string | undefined = actor.endUser): AccessOwner {
  return { credentialId: actor.credentialId, ...(endUser === undefined ? {} : { endUser }) };
}
