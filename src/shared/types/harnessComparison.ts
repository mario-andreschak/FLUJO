import { z } from 'zod';

export const MAX_COMPARISON_VARIANTS = 8;
export const MAX_COMPARISON_CASES = 200;
/** Fits 200 long examples. The page says so before sending rather than after. */
export const HARNESS_COMPARISON_MAX_BODY_BYTES = 2 * 1024 * 1024;

const Phrase = z.string().trim().min(1).max(500);

const ComparisonCaseSchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  input: z.string().trim().min(1).max(8_000),
  required: z.array(Phrase).max(20).default([]),
  forbidden: z.array(Phrase).max(20).default([]),
  expectedTools: z.array(Phrase).max(20).default([]),
  forbiddenTools: z.array(Phrase).max(20).default([]),
  /** What a called tool answers in this case, by tool name. Tools never run for real. */
  toolResults: z.record(z.string().min(1).max(200), z.string().max(32_000)).optional(),
}).strict();

export const HarnessComparisonCaseListSchema = z.array(ComparisonCaseSchema);

const ComparisonVariantSchema = z.object({
  flowId: z.string().trim().min(1).max(256),
  /** Runs every Process step of the flow on this model instead of its own. */
  modelId: z.string().trim().min(1).max(256).optional(),
  label: z.string().trim().min(1).max(200).optional(),
}).strict();

export const HarnessComparisonInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  variants: z.array(ComparisonVariantSchema).min(1).max(MAX_COMPARISON_VARIANTS),
  cases: z.array(ComparisonCaseSchema).min(1).max(MAX_COMPARISON_CASES),
  maxModelCallsPerCase: z.number().int().min(1).max(40).default(8),
}).strict();

export type HarnessComparisonInput = z.output<typeof HarnessComparisonInputSchema>;
export type HarnessComparisonCase = HarnessComparisonInput['cases'][number];

/** The id a result refers to its example by. */
export function harnessComparisonCaseId(example: { id?: string }, index: number): string {
  return example.id ?? `case-${index + 1}`;
}

export type HarnessComparisonStatus = 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';

export interface HarnessComparisonResult {
  variant: number;
  caseId: string;
  /** `error` means the run itself did not finish, so its checks say nothing. */
  status: 'passed' | 'failed' | 'error';
  output: string;
  missing: string[];
  violations: string[];
  missingTools: string[];
  forbiddenToolsCalled: string[];
  toolsCalled: string[];
  /** FLUJO model ids this case used. */
  modelsUsed: string[];
  /** Model names the providers reported, which can differ from what was asked for. */
  reportedModels: string[];
  modelCalls: number;
  tokens: number | null;
  durationMs: number;
  error?: { message: string; code?: string };
}

export interface HarnessComparisonVariantSummary {
  variant: number;
  label: string;
  flowId: string;
  modelId?: string;
  passed: number;
  failed: number;
  errors: number;
  modelCalls: number;
  tokens: number;
  durationMs: number;
}

export interface HarnessComparison {
  schemaVersion: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  status: HarnessComparisonStatus;
  input: HarnessComparisonInput;
  /** One entry per variant and case, added as each finishes. */
  results: HarnessComparisonResult[];
  summary: HarnessComparisonVariantSummary[];
  error?: string;
}

/** One row of `GET /api/harness/comparisons`. */
export interface HarnessComparisonListItem {
  id: string;
  createdAt: number;
  finishedAt?: number;
  status: HarnessComparisonStatus;
  name: string;
  cases: number;
  summary: HarnessComparisonVariantSummary[];
}
