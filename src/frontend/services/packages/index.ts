/**
 * Frontend service for the package-creation wizard (issue #194).
 *
 * Thin fetch wrapper over the local-only `/api/packages/resolve` and
 * `/api/packages/build` routes, following the flowService singleton pattern
 * (list/preview reads swallow errors; build returns a structured result).
 */
import { createLogger } from '@/utils/logger';
import type {
  BuildManifestResult,
  PackageMetadataInput,
  PackageSelection,
  ResolvedSelection,
} from '@/backend/services/packages/buildPackage';
import type { PackageSecret } from '@/shared/types/package/secrets';

const log = createLogger('frontend/services/packages');

export interface ResolveResult {
  resolved: ResolvedSelection;
  mcp: {
    ok: boolean;
    errors: string[];
    servers: Array<{ name: string; sourceType: string }>;
  };
  secrets: PackageSecret[];
}

class PackageService {
  /** Walk a selection to its full dependency closure + MCP validation preview. */
  async resolve(selection: PackageSelection): Promise<ResolveResult> {
    const response = await fetch('/api/packages/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selection),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return body as ResolveResult;
  }

  /** Build the package manifest; returns the structured build result. */
  async build(
    selection: PackageSelection,
    metadata: PackageMetadataInput,
  ): Promise<BuildManifestResult> {
    const response = await fetch('/api/packages/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection, metadata }),
    });
    const body = await response.json();
    if (!response.ok && body?.ok === undefined) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return body as BuildManifestResult;
  }
}

let _packageService: PackageService | null = null;

export const getPackageService = (): PackageService => {
  if (typeof window === 'undefined') {
    throw new Error('PackageService can only be used in browser environment');
  }
  if (!_packageService) {
    _packageService = new PackageService();
  }
  return _packageService;
};

// Lazy proxy so importing this module never throws during SSR/prerender.
export const packageService: PackageService = new Proxy({} as PackageService, {
  get(_target, prop) {
    const service = getPackageService();
    const value = (service as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(service) : value;
  },
});

export type { PackageSelection, PackageMetadataInput, BuildManifestResult, ResolvedSelection };
