import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccountPrincipal } from '@/shared/types/accounts';

/**
 * The signed-in person for the current request, kept next to the selected
 * workspace (#574). `withWorkspaceRoute` sets it once per request from the
 * session cookie or API token; it is never built from a query, header or body
 * claim. Work that has no person (schedules, triggers, personas, startup)
 * runs without it and acts for the workspace owner.
 */

declare global {
  var __flujo_account_principal_als: AsyncLocalStorage<AccountPrincipal> | undefined;
}

function store(): AsyncLocalStorage<AccountPrincipal> {
  global.__flujo_account_principal_als ??= new AsyncLocalStorage<AccountPrincipal>();
  return global.__flujo_account_principal_als;
}

export function runWithAccountPrincipal<T>(principal: AccountPrincipal, task: () => T): T {
  return store().run(principal, task);
}

/** The signed-in person for this request, or `undefined` outside a signed-in request. */
export function currentAccountPrincipal(): AccountPrincipal | undefined {
  return store().getStore();
}

/** Run work that must not act for the person who triggered it (it acts for the workspace owner instead). */
export function runWithoutAccountPrincipal<T>(task: () => T): T {
  return store().exit(task);
}
