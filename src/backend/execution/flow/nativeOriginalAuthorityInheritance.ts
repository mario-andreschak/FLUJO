import type { FlowExecutionAuthority } from './types';

/** Causal wrappers inherit only an already-minted opaque binding. This module
 * has no host/provider dependencies and exposes no mint or registry setter. */
export function inheritNativeOriginalAuthority(parent: FlowExecutionAuthority, child: FlowExecutionAuthority): void {
  const registry = (globalThis as typeof globalThis & {
    __flujoNativeOriginalAuthorities?: WeakMap<object, unknown>;
  }).__flujoNativeOriginalAuthorities;
  const binding = registry?.get(parent);
  if (binding) registry!.set(child, binding);
}
