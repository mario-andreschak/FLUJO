/**
 * Registry-status quality provider — pure, no network. The official registry
 * asserts a lifecycle status per entry; only 'active' is treated as vouched-for
 * (mirrors `isVerifiedStatus` in @/utils/mcp/registry). A weak but free signal
 * that nudges maintained entries above deprecated/withdrawn ones.
 */
import { ServerCandidate, QualitySignalProvider } from '../types';

export const REGISTRY_STATUS_PROVIDER_ID = 'registry-status';

export const registryStatusProvider: QualitySignalProvider = {
  id: REGISTRY_STATUS_PROVIDER_ID,
  label: 'Registry Status',
  defaultWeight: 0.15,

  // Always applicable — every candidate carries a status (defaulting to
  // 'unverified'), so this dimension participates for all of them.
  isApplicable(_c: ServerCandidate) {
    return true;
  },

  // Pure/local — no persistent cache (status is cheap and can change).
  cacheKey() {
    return null;
  },

  async fetch(c) {
    const active = c.verificationStatus === 'active';
    return {
      providerId: REGISTRY_STATUS_PROVIDER_ID,
      score: active ? 1 : 0,
      evidence: { status: c.verificationStatus },
    };
  },
};
