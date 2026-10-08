/**
 * Package-registry lookup helpers (issue #198).
 *
 * Talks to the HOSTED FLUJO PACKAGE REGISTRY (registry.flujo.com.co, issue #196),
 * via `packageRegistryClient` (the same client #197's account/publish flows use).
 * This is NOT the MCP server registry (registry.modelcontextprotocol.io) — that's
 * a separate, unrelated service for installing individual MCP servers.
 *
 * Browsing/installing packages is anonymous (no auth token required); only
 * publishing needs a confirmed registry account.
 */
import { createLogger } from '@/utils/logger';
import { searchPackages, getPackageManifest, type RegistryPackageSearchResult } from '@/backend/utils/packageRegistryClient';

const log = createLogger('backend/services/packages/packageRegistry');

export type { RegistryPackageSearchResult, RegistryPackageSummary } from '@/backend/utils/packageRegistryClient';

/** Search/browse published packages. Returns an empty result set on transport failure. */
export async function searchPackageRegistry(params: {
  q?: string;
  tag?: string;
  page?: number;
  pageSize?: number;
}): Promise<RegistryPackageSearchResult> {
  const { status, body } = await searchPackages(params);
  if (status < 200 || status >= 300) {
    log.warn(`searchPackageRegistry: registry responded with status ${status}`);
    return { items: [], page: params.page ?? 1, pageSize: params.pageSize ?? 20, total: 0, error: body?.error ?? `Registry responded with status ${status}` };
  }
  return body;
}

/**
 * Fetch a package manifest by id. Returns the raw JSON (unknown) so the caller
 * can Zod-validate it. Throws only on transport / non-2xx failures.
 */
export async function fetchPackageManifest(
  packageId: string,
  version?: string,
): Promise<unknown> {
  if (!packageId || typeof packageId !== 'string') {
    throw new Error('A package id is required');
  }
  const { status, body } = await getPackageManifest(packageId, version && version.trim() ? version.trim() : 'latest');
  if (status < 200 || status >= 300) {
    const message = (body as { error?: string; message?: string } | null)?.error
      ?? (body as { error?: string; message?: string } | null)?.message
      ?? `Registry responded with status ${status}`;
    // installPackage() wraps this in its own "Failed to fetch package ..." prefix — keep this bare.
    throw new Error(message);
  }
  return body;
}
