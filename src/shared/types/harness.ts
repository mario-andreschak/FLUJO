import { z } from 'zod';
import { findPromptRefs } from '@/utils/shared/promptRefs';
import { HarnessTargetSchema, type HarnessRuntimeSnapshot, type HarnessToolReplay } from './harnessIntegration';
import { FLOW_INVOCATION_SOURCES } from './execution/invocation';

const text = (max: number) => z.string().trim().min(1).max(max);
const checks = z.array(text(500)).max(12);
export const HarnessPromptSchema = text(12000).refine(value => !value.includes('${') && findPromptRefs(value).length === 0,
  'Harness Lab accepts plain-text instructions only. Remove FLUJO variable, entity, resource and tool bindings.');
export const HarnessCaseSchema = z.object({
  id: text(64),
  split: z.enum(['train', 'holdout']),
  input: text(6000),
  required: checks.default([]),
  forbidden: checks.default([]),
  source: z.enum(FLOW_INVOCATION_SOURCES).optional(),
  tools: z.array(z.object({ name: text(256), arguments: z.record(z.string(), z.unknown()), output: z.string().max(32000), recordingId: text(64).optional() }).strict()).max(32).optional(),
}).strict();

export const HarnessInputSchema = z.object({
  name: text(100),
  domain: text(80),
  modelId: text(128),
  basePrompt: z.string().trim().max(12000),
  rounds: z.number().int().min(1).max(3).default(1),
  cases: z.array(HarnessCaseSchema).min(4).max(12),
  reuseLessons: z.boolean().default(true),
  target: HarnessTargetSchema.optional(),
  rubric: z.string().trim().min(20).max(4000).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.target && !HarnessPromptSchema.safeParse(value.basePrompt).success) {
    ctx.addIssue({ code: 'custom', message: 'Standalone experiments accept plain-text instructions only.', path: ['basePrompt'] });
  }
  if (value.cases.some(item => item.required.length === 0) && !value.rubric) {
    ctx.addIssue({ code: 'custom', message: 'Supply required phrases or an evaluation rubric.', path: ['cases'] });
  }
  for (const split of ['train', 'holdout'] as const) {
    if (value.cases.filter(item => item.split === split).length < 2) {
      ctx.addIssue({ code: 'custom', message: `Provide at least two distinct ${split} examples.`, path: ['cases'] });
    }
  }
  if (new Set(value.cases.map(item => item.id)).size !== value.cases.length
    || new Set(value.cases.map(item => normalizeHarnessTask(item.input))).size !== value.cases.length) {
    ctx.addIssue({ code: 'custom', message: 'Example IDs and inputs must be distinct across both splits.', path: ['cases'] });
  }
  value.cases.forEach((example, index) => {
    const required = example.required.map(normalizeHarnessTask);
    const forbidden = example.forbidden.map(normalizeHarnessTask);
    if (new Set(required).size !== required.length || new Set(forbidden).size !== forbidden.length
      || required.some(value => forbidden.some(blocked => value.includes(blocked)))) {
      ctx.addIssue({ code: 'custom', message: 'Checks must be distinct and required text must not contain forbidden text.', path: ['cases', index] });
    }
  });
});

/** Catch exact/case/whitespace duplicates; semantic independence still needs human review. */
export function normalizeHarnessTask(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A revision may preserve existing authority-bearing bindings, never add or remove one. */
export function harnessBindingsUnchanged(before: string, after: string): boolean {
  const bindings = (value: string) => [...value.matchAll(/\$\{[^}]*\}/g)].map(match => match[0]).sort();
  const known = (value: string) => findPromptRefs(value).map(ref => ref.fullMatch).sort();
  return JSON.stringify(bindings(before)) === JSON.stringify(bindings(after)) && JSON.stringify(known(before)) === JSON.stringify(known(after));
}

export type HarnessInput = z.infer<typeof HarnessInputSchema>;
export type HarnessCase = z.infer<typeof HarnessCaseSchema>;
export type HarnessScope = 'baseline' | 'general' | 'domain' | 'composed';
export interface HarnessProbe {
  caseId: string;
  split: 'train' | 'holdout';
  promptHash: string;
  output: string;
  quality: number;
  compliance: number;
  missing: string[];
  violations: string[];
  durationMs: number;
  tokens: number | null;
  evaluatorReason?: string;
  evaluationFailure?: string;
  systemPrompts?: Array<{ nodeId: string; hash: string; text: string }>;
  replayedTools?: number;
  toolTrace?: Array<{ name: string; arguments: Record<string, unknown>; matched: boolean }>;
}
export interface HarnessCandidate {
  id: string;
  parentId?: string;
  round: number;
  scope: HarnessScope;
  prompt: string;
  promptHash: string;
  rationale: string;
  probes: HarnessProbe[];
}
export interface HarnessLesson {
  sourceId: string;
  domain: string;
  text: string;
}
export interface HarnessRun {
  schemaVersion: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  input: HarnessInput;
  model: { id: string; name: string; adapter: string; authentication: 'codex-subscription' | 'openrouter' };
  modelFingerprint: string;
  candidates: HarnessCandidate[];
  lessons: HarnessLesson[];
  selectedId?: string;
  frontierIds: string[];
  decision?: { eligible: boolean; reasons: string[] };
  lesson?: string;
  lessonScope?: string;
  /** Written before dispatch. An uncertain provider outcome is never replayed. */
  pendingOperation?: string;
  callsStarted: number;
  callsCompleted: number;
  totalTokens: number;
  unknownUsageCalls: number;
  modelTimeMs: number;
  error?: string;
  promotedFlowId?: string;
  promotedPromptHash?: string;
  runtime?: HarnessRuntimeSnapshot;
  runtimeVariants?: Partial<Record<HarnessRuntimeSnapshot['invocation'], HarnessRuntimeSnapshot>>;
  caseInvocations?: Record<string, HarnessRuntimeSnapshot['invocation']>;
  casePersonaToolPolicies?: Record<string, import('./harnessIntegration').HarnessPersonaToolPolicy>;
  toolReplays?: Record<string, HarnessToolReplay[]>;
  profileId?: string;
  activatedVersionId?: string;
  origin?: 'manual' | 'automatic';
  modelCallsStarted?: number;
  modelCallsCompleted?: number;
  caseMessages?: Record<string, import('@/shared/types/chat').FlujoChatMessage[]>;
  caseInputs?: Record<string, import('./execution/flowInputs').FlowReplayInputs>;
  /** Read-only resource responses frozen by the first probe and reused by every candidate. */
  resourceSnapshots?: Record<string, unknown>;
}

export function harnessCallLimit(input: HarnessInput): number {
  const training = input.cases.filter(item => item.split === 'train').length;
  const holdout = input.cases.length - training;
  return training + input.rounds * (3 + 3 * training) + 2 * holdout + 1;
}
