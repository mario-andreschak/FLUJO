/**
 * Package-registry HTTP client (issue #198).
 *
 * Fetches a raw package manifest by id (and optional version) from the online
 * package registry. The registry API itself is #196 — until that ships, the
 * origin is configurable via `FLUJO_PACKAGE_REGISTRY_ORIGIN` and defaults to the
 * MCP registry origin. Kept in its own module (separate from the orchestrator)
 * so tests can mock the network boundary independently.
 *
 * Node-only: reuses the registry HTTP client (HTTP/2 with an HTTP/1.1 fallback).
 * Returns the raw parsed JSON — validation is the orchestrator's job (via
 * parsePackageManifest), so a malformed manifest is reported as data, not thrown.
 */
import { createLogger } from '@/utils/logger';
import { REGISTRY_ORIGIN, registryGetJson } from '@/backend/utils/registryClient';

const log = createLogger('backend/services/packages/packageRegistry');

const PACKAGE_FETCH_TIMEOUT_MS = 15_000;
const PACKAGES_PATH = '/v0.1/packages';

/** Origin of the package registry (opt-in override for hosted / #196 wiring). */
function packageRegistryOrigin(): string {
  return process.env.FLUJO_PACKAGE_REGISTRY_ORIGIN?.trim() || REGISTRY_ORIGIN;
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
  const url = new URL(`${packageRegistryOrigin()}${PACKAGES_PATH}/${encodeURIComponent(packageId)}`);
  url.searchParams.set('version', version && version.trim() ? version.trim() : 'latest');
  log.info(`fetchPackageManifest: GET ${url.pathname}${url.search}`);
  return registryGetJson(url, PACKAGE_FETCH_TIMEOUT_MS);
}
