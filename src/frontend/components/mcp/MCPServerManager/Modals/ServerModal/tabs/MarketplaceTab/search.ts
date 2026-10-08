import {
  displayName,
  getInstallOptions,
  isAutoInstallable,
  isVerifiedStatus,
  verificationStatusOf,
  type RegistryServerResult,
} from '@/utils/mcp/registry';

export type MarketplaceTransportFilter = 'all' | 'local' | 'remote';
export type MarketplaceSetupFilter = 'all' | 'automatic' | 'manual';
export type MarketplaceVerificationFilter = 'all' | 'verified' | 'unverified';
export type MarketplaceSort = 'relevance' | 'stars' | 'downloads' | 'name';

export interface MarketplaceSearchFilters {
  transport: MarketplaceTransportFilter;
  setup: MarketplaceSetupFilter;
  verification: MarketplaceVerificationFilter;
  sort: MarketplaceSort;
}

export const DEFAULT_MARKETPLACE_FILTERS: MarketplaceSearchFilters = {
  transport: 'all',
  setup: 'all',
  verification: 'all',
  sort: 'relevance',
};

export function hasActiveMarketplaceFilters(filters: MarketplaceSearchFilters): boolean {
  return filters.transport !== 'all'
    || filters.setup !== 'all'
    || filters.verification !== 'all'
    || filters.sort !== 'relevance';
}

function isAutomaticallyInstallable(result: RegistryServerResult): boolean {
  return getInstallOptions(result.server).some(isAutoInstallable);
}

function descendingQuality(
  getValue: (result: RegistryServerResult) => number | undefined,
): (left: RegistryServerResult, right: RegistryServerResult) => number {
  return (left, right) => {
    const leftValue = getValue(left);
    const rightValue = getValue(right);
    if (leftValue === undefined && rightValue === undefined) return 0;
    if (leftValue === undefined) return 1;
    if (rightValue === undefined) return -1;
    return rightValue - leftValue;
  };
}

/**
 * Refine the registry pages already loaded by the Marketplace. Relevance keeps
 * the quality-ranked order returned by the API; the other sorts are stable and
 * put entries without that quality signal last.
 */
export function filterMarketplaceResults(
  results: RegistryServerResult[],
  filters: MarketplaceSearchFilters,
): RegistryServerResult[] {
  const filtered = results.filter(result => {
    const { server } = result;
    const automatic = isAutomaticallyInstallable(result);
    const verified = isVerifiedStatus(verificationStatusOf(result));

    if (filters.transport === 'local' && (server.packages?.length ?? 0) === 0) return false;
    if (filters.transport === 'remote' && (server.remotes?.length ?? 0) === 0) return false;
    if (filters.setup === 'automatic' && !automatic) return false;
    if (filters.setup === 'manual' && automatic) return false;
    if (filters.verification === 'verified' && !verified) return false;
    if (filters.verification === 'unverified' && verified) return false;
    return true;
  });

  switch (filters.sort) {
    case 'stars':
      return filtered.sort(descendingQuality(result => result.quality?.stars));
    case 'downloads':
      return filtered.sort(descendingQuality(result => result.quality?.weeklyDownloads));
    case 'name':
      return filtered.sort((left, right) => displayName(left.server).localeCompare(displayName(right.server)));
    default:
      return filtered;
  }
}
