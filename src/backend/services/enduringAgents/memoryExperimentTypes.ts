import type {
  MemoryKind,
  MemoryScope,
  MemoryStatus,
  MemoryTrust,
} from '@/shared/types/enduringAgent';

export interface MemoryRankingWeights {
  readonly importanceWeight: number;
  readonly confidenceWeight: number;
  readonly exactContentMatchBonus: number;
  readonly termHitBonus: number;
  readonly termCoverageBonus: number;
  readonly lengthNormalisationChars: number;
  readonly lengthNormalisationFloor: number;
  readonly recencyHalfLifeDays: number;
  readonly recencyFloor: number;
  readonly trustWeights: Readonly<Record<MemoryTrust, number>>;
  readonly coreBonus: number;
  readonly coreExemptFromDecay: boolean;
  readonly lexicalWeight: number;
  readonly semanticWeight: number;
}

export interface MemoryDedupSettings {
  readonly enabled: boolean;
  readonly shingleSize: number;
  readonly nearDuplicateThreshold: number;
  readonly comparisonWindow: number;
  readonly confidenceReinforcementStep: number;
  readonly importanceReinforcementStep: number;
  readonly maxSourceRefsPerItem: number;
}

export interface MemoryRankingCandidate {
  readonly id: string;
  readonly content: string;
  readonly confidence: number;
  readonly importance: number;
  readonly trust: MemoryTrust;
  readonly updatedAt: number;
}

export interface MemoryDedupCandidate {
  readonly id: string;
  readonly content: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly status: MemoryStatus;
  readonly updatedAt: number;
}

export interface IncomingMemoryDedupCandidate {
  readonly content: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
}

export interface MemoryExperimentVariant {
  readonly id: string;
  readonly ranking: MemoryRankingWeights;
  readonly dedup: MemoryDedupSettings;
}

export interface MemoryExperimentVariantInput {
  readonly id: string;
  readonly ranking?: Readonly<Partial<Omit<MemoryRankingWeights, 'trustWeights'>> & {
    readonly trustWeights?: Readonly<Partial<Record<MemoryTrust, number>>>;
  }>;
  readonly dedup?: Readonly<Partial<MemoryDedupSettings>>;
}

export type MemoryExperimentItem = MemoryRankingCandidate & MemoryDedupCandidate & {
  readonly core?: boolean;
};

export interface MemoryExperimentQueryCase {
  readonly id: string;
  readonly query: string;
  readonly asOf: number;
  readonly topK: number;
  readonly relevantIds: readonly string[];
  readonly expectedOrder?: readonly string[];
  readonly candidateIds?: readonly string[];
  readonly semanticScores?: Readonly<Record<string, number>>;
}

export interface MemoryExperimentDuplicateCase {
  readonly id: string;
  readonly incoming: IncomingMemoryDedupCandidate;
  readonly expectedDuplicate: boolean;
  readonly expectedSurvivorId?: string;
  readonly candidateIds?: readonly string[];
}

export interface MemoryExperimentDataset {
  readonly version: string;
  readonly description?: string;
  readonly items: readonly MemoryExperimentItem[];
  readonly queries: readonly MemoryExperimentQueryCase[];
  readonly duplicates: readonly MemoryExperimentDuplicateCase[];
}

export interface FractionMetric {
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
}

export interface DuplicateMergeCounts {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
}

export interface MemoryExperimentQueryOutcome {
  readonly caseId: string;
  readonly expectedRelevantIds: readonly string[];
  readonly expectedOrder: readonly string[];
  readonly actualIds: readonly string[];
  readonly hit: boolean;
  readonly recallAtK: FractionMetric;
  readonly exactOrderMatch: boolean | null;
}

export interface MemoryExperimentDuplicateOutcome {
  readonly caseId: string;
  readonly expectedDuplicate: boolean;
  readonly expectedSurvivorId: string | null;
  readonly predictedDuplicate: boolean;
  readonly actualSurvivorId: string | null;
  readonly similarity: number | null;
  readonly correct: boolean;
}

export interface MemoryExperimentResult {
  readonly variantId: string;
  readonly fixtureVersion: string;
  readonly mode: 'lexical-only' | 'fixture-semantic';
  readonly effectiveSettings: {
    readonly ranking: MemoryRankingWeights;
    readonly dedup: MemoryDedupSettings;
  };
  readonly metrics: {
    readonly recallHitRate: FractionMetric;
    readonly recallAtK: FractionMetric;
    readonly rankingAccuracy: FractionMetric;
    readonly duplicateMergePrecision: FractionMetric;
    readonly duplicateRecall: FractionMetric;
    readonly duplicateCounts: DuplicateMergeCounts;
  };
  readonly queryOutcomes: readonly MemoryExperimentQueryOutcome[];
  readonly duplicateOutcomes: readonly MemoryExperimentDuplicateOutcome[];
}
