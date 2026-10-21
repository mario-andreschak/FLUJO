import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const localRuntimePolicySchema = z.object({
  kind: z.literal('local-docker'),
  executable: z.string().min(1).max(2048).refine(value => isAbsolute(value) && !value.includes('\0')),
  daemon: z.string().max(1024).refine(value => /^unix:\/\/\/[A-Za-z0-9_./-]+\.sock$/.test(value)
    || /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_-]+$/.test(value)),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  generation: z.string().regex(/^[a-f0-9]{32}$/),
  dataVolume: z.string().regex(/^flujo-owner-[a-f0-9]{32}-data$/),
  homeVolume: z.string().regex(/^flujo-owner-[a-f0-9]{32}-home$/),
  authorityVolume: z.string().regex(/^flujo-owner-[a-f0-9]{32}-authority$/),
  credentialExpiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  memoryMiB: z.number().int().min(512).max(32768),
  cpus: z.number().min(0.5).max(16).multipleOf(0.1),
  pidsLimit: z.number().int().min(64).max(4096),
}).strict().superRefine((policy, context) => {
  for (const [key, suffix] of [['dataVolume', 'data'], ['homeVolume', 'home'], ['authorityVolume', 'authority']] as const) {
    if (policy[key] !== `flujo-owner-${policy.generation}-${suffix}`) {
      context.addIssue({ code: 'custom', message: 'Local volume must belong to this runtime generation' });
    }
  }
});

export type LocalRuntimePolicy = z.infer<typeof localRuntimePolicySchema>;
export type RuntimeState = 'running' | 'stopped';
export type RuntimeProblem = 'local-engine-unavailable' | 'identity-mismatch' | 'isolation-mismatch'
  | 'state-unconfirmed' | 'superseded' | 'credential-expired';
export interface RuntimeIntent {
  runtimeId: string; actorId: string; origin: string; generation: number;
  desired: RuntimeState; phase: 'pending' | 'confirmed' | 'failed';
  policy: LocalRuntimePolicy; verifiedAt: number | null; problem: RuntimeProblem | null;
  credentialDigest: string;
}
export class RuntimeControlError extends Error {
  constructor(readonly problem: RuntimeProblem) { super(problem); }
}
