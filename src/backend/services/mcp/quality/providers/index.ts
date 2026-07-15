/**
 * The provider registry — the single add / remove / swap point for quality
 * signal sources. To add an aggregator (Glama, PulseMCP, mcp.so, …), implement
 * `QualitySignalProvider` in a sibling file and add it to this array; nothing
 * else in the quality layer changes. To retire one, delete its entry.
 *
 * FUTURE (documented, intentionally NOT wired in v1): aggregator providers such
 * as `glama` and `pulsemcp` slot in here. They are the tokenless answer to
 * GitHub's rate limit — each computes stars/popularity server-side, so a single
 * bulk `prefetch()` avoids the GitHub budget entirely. Add them once we can A/B
 * whether they improve picks over GitHub+npm.
 */
import { QualitySignalProvider } from '../types';
import { githubProvider } from './githubStars';
import { npmDownloadsProvider } from './npmDownloads';
import { registryStatusProvider } from './registryStatus';

export const PROVIDERS: QualitySignalProvider[] = [
  githubProvider,
  npmDownloadsProvider,
  registryStatusProvider,
];

export function providerById(id: string): QualitySignalProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
