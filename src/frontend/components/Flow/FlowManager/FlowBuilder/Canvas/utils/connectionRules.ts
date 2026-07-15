/**
 * Connection legality rules — the single source of truth moved to
 * `@/utils/shared/connectionRules` so the backend + the pure compile/repair modules can
 * share it. This file re-exports it unchanged so the many existing frontend imports
 * (edgeUtils, NodeSelectionModal, …) keep working.
 */
export {
  isMcpHandle,
  getConnectionError,
  defaultTargetHandleFor,
  validTargetTypesFor,
} from '@/utils/shared/connectionRules';
