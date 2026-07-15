/**
 * Quality-signal provider layer for headless MCP-server auto-install (issue: the
 * registry install path had no notion of "good" — it took the first hit).
 *
 * A PROVIDER is one source of a quality signal (GitHub stars/recency, npm weekly
 * downloads, registry status, and later aggregators like Glama/PulseMCP). Each is
 * a self-contained module implementing `QualitySignalProvider`; the swap/add/
 * remove point is the single array in `providers/index.ts`. The orchestrator
 * (`orchestrator.ts`) runs the enabled providers over the registry candidates,
 * blends their normalized scores (`scorer.ts`) and ranks best-first.
 *
 * Rate-limit posture is a PROVIDER-INTERNAL concern: a provider that talks to a
 * rate-limited API (GitHub) does its network in one bulk `prefetch()` and serves
 * per-candidate `fetch()` from that warmed data, so swapping the source can't
 * leak rate-limit logic into the orchestrator.
 */
import { RegistryServer } from '@/utils/mcp/registry';

/** A registry entry under consideration, with the fields providers score on. */
export interface ServerCandidate {
  /** Registry name, e.g. "ai.keenable/web-search". */
  registryName: string;
  server: RegistryServer;
  /** Registry lifecycle status ('active' | 'deprecated' | 'unverified' …). */
  verificationStatus: string;
}

/** One provider's verdict on one candidate. `score` is normalized 0..1. */
export interface QualitySignal {
  providerId: string;
  /** Normalized 0..1 contribution for this provider's dimension. */
  score: number;
  /** Raw facts behind the score, for UI badges + audit. Never secrets. */
  evidence: Record<string, unknown>;
}

export interface QualitySignalProvider {
  /** Stable id — used as the settings key and the cache namespace. */
  readonly id: string;
  /** Human-facing label for settings UI. */
  readonly label: string;
  /** Weight used when settings don't override it. */
  readonly defaultWeight: number;

  /**
   * Whether this provider can say anything about the candidate. A provider that
   * is NOT applicable (e.g. npm-downloads for a remote-only server) is excluded
   * from that candidate's score denominator — no unfair penalty. A provider that
   * IS applicable but returns no signal counts as score 0 (keeps its weight).
   */
  isApplicable(c: ServerCandidate): boolean;

  /**
   * Cache key for this candidate under this provider (e.g. "owner/repo" for
   * GitHub, the npm package name for npm-downloads). Return null to opt out of
   * persistent caching (pure/local providers like registry-status).
   */
  cacheKey(c: ServerCandidate): string | null;

  /**
   * OPTIONAL bulk warm-up: given the candidates that still need a fresh signal,
   * fetch them in as few requests as possible (one GitHub search, one comma-
   * batched npm call, …). Errors here must NOT throw the search — the provider
   * should swallow/log and let `fetch()` degrade to null.
   */
  prefetch?(query: string, candidates: ServerCandidate[], signal: AbortSignal): Promise<void>;

  /**
   * The provider's signal for one candidate, or null when it has nothing to say
   * (fetch failed, rate-limited, repo missing). For network providers this reads
   * the map warmed by `prefetch()`; it should not itself fan out per-candidate
   * requests except as an explicit, bounded fallback.
   */
  fetch(c: ServerCandidate, signal: AbortSignal): Promise<QualitySignal | null>;
}

/** A candidate with its blended score and the signals that produced it. */
export interface ScoredCandidate {
  candidate: ServerCandidate;
  /** Composite 0..1 across applicable providers. */
  score: number;
  signals: QualitySignal[];
}
