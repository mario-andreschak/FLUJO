// Jest-only compatibility adapter for tests that exercise the historical backend
// module paths. Standalone subprocess tests load @flujo-ai/mcp-shared from its
// compiled workspace package and therefore do not pass through this adapter.
export { createLogger } from '@/utils/logger';
export { getDataDir } from '@/utils/paths';
export {
  envRoots,
  isInside,
  loadEffectiveRoots,
} from '@/backend/services/mcp/internal/confinement';
export { killProcessTree } from '@/utils/process/killProcessTree';

export type RootsProvider = () => Promise<Array<{ uri: string }>>;

// Package entrypoints install a roots provider before accepting requests. Jest's
// direct handler tests use the backend confinement adapter above instead.
export function configureRootsProvider(_provider: RootsProvider | undefined): void {
  // Intentionally empty in the compatibility test environment.
}
