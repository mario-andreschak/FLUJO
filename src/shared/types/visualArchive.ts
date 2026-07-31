import type { ModelAdapter, ModelProvider } from './model/provider';

export type VisionInputCapability = 'supported' | 'unsupported' | 'unknown';
export type VisualCompactionRoute = 'image' | 'text' | 'summary' | 'raw';
export type VisualCompactionFallbackReason =
  | 'disabled'
  | 'evaluation-only'
  | 'missing-conversation'
  | 'self-orchestrating-adapter'
  | 'vision-unsupported'
  | 'vision-unknown'
  | 'no-eligible-range'
  | 'below-size-threshold'
  | 'poor-density'
  | 'secret-detected'
  | 'render-failed'
  | 'stash-failed'
  | 'estimate-failed'
  | 'non-positive-savings';

export interface VisualArchivePageMetadata {
  index: number;
  width: number;
  height: number;
  bytes: number;
  imageTokens: number;
  resourceUri?: string;
}

export interface VisualArchiveExactString {
  kind: 'path' | 'url' | 'command' | 'hash' | 'id' | 'error' | 'tool';
  value: string;
}

export interface VisualArchiveCandidate {
  startIndex: number;
  endIndex: number;
  messageCount: number;
  originalCharacters: number;
  textDensity: number;
  toolResultsOnly: boolean;
  exactStrings: VisualArchiveExactString[];
}

export interface VisualCompactionEstimates {
  rawTextTokens: number;
  compactedTextTokens: number;
  summaryTokens: number;
  imageTokens: number;
  sidecarTokens: number;
  selectedTokens: number;
  netSavings: number;
  savingsPercent: number;
}

export interface VisualCompactionDiagnostic {
  enabled: boolean;
  evaluationOnly: boolean;
  provider?: ModelProvider;
  adapter?: ModelAdapter;
  model: string;
  capability: VisionInputCapability;
  route: VisualCompactionRoute;
  fallbackReason?: VisualCompactionFallbackReason;
  candidate?: VisualArchiveCandidate;
  estimates?: VisualCompactionEstimates;
  pages: VisualArchivePageMetadata[];
  sourceResourceUri?: string;
  sourceSha256?: string;
  latencyMs: number;
  renderedBytes: number;
  /** The final generic chat wire after visual + lossless compaction. */
  finalWireCaptured?: boolean;
  stashFetches?: number;
  stashVerifications?: Array<{ at: number; ok: boolean }>;
  cacheHitInputTokens?: number;
  correctionOutcomes?: Array<{ at: number; outcome: 'confirmed' | 'corrected' | 'fallback' }>;
}

export interface VisualArchiveResourceMetadata {
  archiveId: string;
  role: 'source' | 'page';
  pageIndex?: number;
  pageCount?: number;
  route: VisualCompactionRoute;
  sourceSha256: string;
}
