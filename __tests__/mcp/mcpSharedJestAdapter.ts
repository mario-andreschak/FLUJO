// Jest-only compatibility adapter for tests that exercise the historical backend
// module paths. Standalone subprocess tests load @flujo-ai/mcp-shared from its
// compiled workspace package and therefore do not pass through this adapter.
import { getDataDir } from '@/utils/paths';
import { isInside } from '@/backend/services/mcp/internal/confinement';
import { currentProjectDir } from '../../mcp-servers/shared/src/index';

export { createLogger } from '@/utils/logger';
export { getDataDir };
export {
  envRoots,
  isInside,
  loadEffectiveRoots,
} from '@/backend/services/mcp/internal/confinement';
export { killProcessTree } from '@/utils/process/killProcessTree';
// Bash waits for the standalone package's close-event contract, which differs
// from the backend helper's exit-event contract and options signature.
export {
  killProcessTreeAndWait,
  type ProcessTreeTerminationResult,
} from '../../mcp-servers/shared/src/index';

export { currentProjectDir, projectDirOf, runWithProjectDir } from '../../mcp-servers/shared/src/index';

// Same choice as the package helper, with the backend data dir used above.
export function workingBaseDir(roots: readonly string[]): string {
  const projectDir = currentProjectDir();
  if (projectDir && roots.some(root => isInside(root, projectDir))) return projectDir;
  return getDataDir();
}

export type RootsProvider = () => Promise<Array<{ uri: string }>>;

// Package entrypoints install a roots provider before accepting requests. Jest's
// direct handler tests use the backend confinement adapter above instead.
export function configureRootsProvider(_provider: RootsProvider | undefined): void {
  // Intentionally empty in the compatibility test environment.
}
