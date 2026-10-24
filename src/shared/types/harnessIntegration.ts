import { z } from 'zod';
import type { Flow } from './flow';
import type { PersonaInstructionContext, PersonaAttribution } from './enduringAgent';

const id = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
export const HarnessTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('flow'), flowId: id, nodeId: id }).strict(),
  z.object({ kind: z.literal('persona'), personaId: id, behaviorId: id, nodeId: id }).strict(),
]);
export type HarnessTarget = z.infer<typeof HarnessTargetSchema>;
export const HarnessPolicySchema = z.object({
  automatic: z.boolean().default(false),
  modelId: id,
  rubric: z.string().trim().min(20).max(4000).default('Complete the user task accurately, follow the operational instructions, ground factual claims in the supplied evidence, and do not invent completed actions or exceed the available permissions.'),
  rounds: z.number().int().min(1).max(3).default(1),
  cooldownMinutes: z.number().int().min(1).max(1440).default(15),
  maxModelCallsPerProbe: z.number().int().min(1).max(16).default(4),
}).strict();
export type HarnessPolicy = z.infer<typeof HarnessPolicySchema>;
export interface HarnessToolReplay { name: string; arguments: Record<string, unknown>; output: string; recordingId?: string }
/** Captured schema variation, never an execution capability. */
export interface HarnessPersonaToolPolicy { maintenanceMemoryProposal: boolean }
export interface HarnessRuntimeSnapshot {
  target: HarnessTarget;
  flow: Flow;
  baseRevision: string;
  contextHash: string;
  modelFingerprints: Record<string, string>;
  personaContext?: PersonaInstructionContext;
  personaAttribution?: PersonaAttribution;
  /** Core admission and nested Behavior invocation intentionally use different context. */
  invocation: 'flow' | 'persona-activity' | 'persona-behavior';
  evaluationFlow?: Flow;
  personaCoreAppRefs?: string[];
  behaviorToolRegistry?: import('./execution/behaviorTools').BehaviorToolRegistry;
  authoredFlow?: { flowRef: string; contentHash: string; updatedAt?: number };
  maxModelCallsPerProbe: number;
  policyHash?: string;
}
export interface HarnessVersion {
  id: string;
  createdAt: number;
  parentId?: string;
  experimentId?: string;
  label: string;
  prompt: string;
  /** Full snapshots live in immutable blobs, outside the frequently read profile. */
  flow?: Flow;
  flowHash: string;
  behaviorRevisionId?: string;
  activatedAt?: number;
}
export interface HarnessProfile {
  id: string;
  target: HarnessTarget;
  policy: HarnessPolicy;
  updatedAt: number;
  versions: HarnessVersion[];
  activeVersionId: string;
  events: Array<{ at: number; action: string; versionId?: string; experimentId?: string; detail: string }>;
  pendingActivation?: { versionId: string; expectedRevision: string; actor: string };
  nextRunAt?: number;
  runningExperimentId?: string;
  lastError?: string;
}
export interface HarnessObservation {
  id: string;
  profileId: string;
  sourceRunId: string;
  createdAt: number;
  input: string;
  output: string;
  tools: HarnessToolReplay[];
  consumedBy?: string;
  messages?: import('@/shared/types/chat').FlujoChatMessage[];
  executionInputs?: import('./execution/flowInputs').FlowReplayInputs;
  invocation?: HarnessRuntimeSnapshot['invocation'];
  /** This turn's invocation, not the conversation's immutable creation origin. */
  source?: import('./execution/invocation').FlowInvocationSource;
  personaToolPolicy?: HarnessPersonaToolPolicy;
}
