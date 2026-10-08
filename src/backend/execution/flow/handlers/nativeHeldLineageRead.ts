import type { FlowExecutionAuthority } from '../types';
import { flowAssertionRoot, type FlowDurableMutationContext } from '../executionAuthority';
import { getCurrentWorkspace } from '@/utils/workspace';
import { hasExecutionReadGuards } from '@/backend/execution/extensions';

const unsupportedAdmissions = new WeakSet<object>();
class UnsupportedNativeHeldRead extends Error {
  constructor() { super('Unsupported native held-read admission.'); unsupportedAdmissions.add(this); }
}
/** Names, prototypes and serialized errors cannot request a fallback. */
export function isUnsupportedNativeHeldRead(error: unknown): boolean {
  return typeof error === 'object' && error !== null && unsupportedAdmissions.has(error);
}

export interface NativeHeldLineageRead {
  readonly assertCurrent: () => Promise<void>;
  readonly assertGuardEligibility: () => void;
  readonly assertFlowCurrent: (context: FlowDurableMutationContext) => Promise<void>;
}

const readers = new WeakSet<object>();

export function assertNativeHeldLineageRead(value: NativeHeldLineageRead): void {
  if (!readers.has(value)) throw new Error('A live native held reader is required.');
}

/**
 * The genuine Dispatcher supplies the callback and exact lease. Native binding
 * identity additionally pins Persona/workspace/Activity/goal/root Original.
 * Generic inheritance alone never proves equivalence of an authority assertion.
 */
export async function withNativeHeldLineageRead<T>(
  authority: FlowExecutionAuthority,
  originConversationId: string,
  rootConversationId: string,
  task: (reader: NativeHeldLineageRead) => Promise<T>,
): Promise<T> {
  const root = flowAssertionRoot(authority);
  const registry = (globalThis as typeof globalThis & {
    __flujoNativeOriginalAuthorities?: WeakMap<object, unknown>;
  }).__flujoNativeOriginalAuthorities;
  const binding = registry?.get(root);
  if (!binding || registry?.get(authority) !== binding) throw new UnsupportedNativeHeldRead();
  const workspace = getCurrentWorkspace();
  const assertGuardEligibility = () => {
    if (hasExecutionReadGuards()) throw new Error('Native held-read guard shape changed.');
  };
  if (hasExecutionReadGuards()) throw new UnsupportedNativeHeldRead();
  // Selection-only admission runs before taking the held lock. No authority
  // verdict or lineage fields from these reads are reused by either trace.
  const { loadConversationStateReadOnly } = await import('../loadConversationState');
  const seen = new Set<string>();
  let id: string | undefined = originConversationId;
  const assertAdmissionGuardEligibility = (state?: unknown) => {
    if (hasExecutionReadGuards() || (state && typeof state === 'object'
      && ((state as { executionExtensionOwned?: boolean }).executionExtensionOwned
        || (state as { executionExtensionContext?: unknown }).executionExtensionContext))) {
      throw new UnsupportedNativeHeldRead();
    }
  };
  while (id) {
    if (seen.has(id) || seen.size >= 256) throw new Error('Native held-read admission lineage is invalid.');
    seen.add(id);
    // Check eligibility before each original access guard: no arbitrary guard
    // runs and no swallowed ordinary guard failure can become a fallback.
    const state = await loadConversationStateReadOnly(id, assertAdmissionGuardEligibility);
    if (!state) throw new Error('Native held-read admission state is unavailable.');
    const candidate = state?.executionAuthority;
    if (!candidate || state?.executionExtensionOwned || state?.executionExtensionContext
      || flowAssertionRoot(candidate) !== root || registry?.get(candidate) !== binding
      || hasExecutionReadGuards()) throw new UnsupportedNativeHeldRead();
    if (id === rootConversationId) break;
    id = state.parentRunId;
  }
  if (!seen.has(rootConversationId)) throw new Error('Native held-read admission root is unavailable.');
  const dispatcher = await import('@/backend/services/enduringAgents/personaDispatcher');
  const assertPersonaAuthority: (value: unknown) => asserts value is FlowExecutionAuthority = dispatcher.assertPersonaFlowExecutionAuthority;
  assertPersonaAuthority(root);
  return dispatcher.readWithPersonaFlowAuthority(root, async (assertDispatcherCurrent) => {
    let active = true;
    const assertCurrent = async () => {
      if (!active || getCurrentWorkspace() !== workspace) throw new Error('Native held read scope ended.');
      await assertDispatcherCurrent();
      if (!active || registry?.get(root) !== binding) throw new Error('Native held read binding changed.');
    };
    const reader: NativeHeldLineageRead = Object.freeze({
      assertCurrent,
      assertGuardEligibility: () => {
        assertNativeHeldLineageRead(reader);
        assertGuardEligibility();
      },
      assertFlowCurrent: async (context: FlowDurableMutationContext) => {
        assertNativeHeldLineageRead(reader);
        const candidate = context.executionAuthority;
        // Extension adapters are arbitrary assertions and have no proven lock
        // equivalence. Release the lock and retain their original guard path.
        if (context.executionExtensionContext || !candidate
          || flowAssertionRoot(candidate) !== root || registry?.get(candidate) !== binding) {
          throw new Error('Native held-read authority shape changed.');
        }
        candidate.signal.throwIfAborted();
        await assertCurrent();
        candidate.signal.throwIfAborted();
      },
    });
    readers.add(reader);
    try {
      await assertCurrent();
      const result = await task(reader);
      await assertCurrent();
      return result;
    } finally {
      active = false;
      readers.delete(reader);
    }
  });
}
