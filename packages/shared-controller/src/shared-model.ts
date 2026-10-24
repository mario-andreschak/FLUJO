import { z } from 'zod';

// Browser-safe protocol: no filesystem, account authority or provider imports.
// Native model publication is an allowlist; new private model fields cannot
// silently enter team storage when the application model grows.
export const SHARED_MODEL_FORMAT = 'flujo.model.v1';
const text = (max: number) => z.string().max(max);
const count = z.number().int().positive().max(1_000_000_000);
const labels = z.array(text(128)).max(64);
const endpoint = text(2048).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}, 'Use an HTTP(S) endpoint without credentials, query parameters or fragments.');
export const sharedModelSchema = z.object({
  name: text(256).min(1), displayName: text(120).optional(), description: text(10000).optional(),
  baseUrl: endpoint.optional(), azureApiVersion: text(128).optional(),
  provider: z.enum(['openai', 'azure', 'openrouter', 'orcarouter', 'requesty', 'anthropic', 'gemini', 'mistral', 'xai',
    'ollama', 'litellm', 'claude-subscription', 'codex', 'antigravity-cli']).optional(),
  adapter: z.enum(['openai', 'openai-responses', 'openrouter-agent', 'azure', 'gemini', 'anthropic', 'claude-cli', 'codex-cli', 'antigravity-cli']).optional(),
  promptTemplate: text(200000).optional(), reasoningSchema: text(100000).optional(), functionCallingSchema: text(100000).optional(),
  temperature: text(32).optional(), reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(), thinkingBudget: z.number().int().min(-1).max(1_000_000_000).optional(),
  serviceTier: z.enum(['default', 'priority']).optional(), contextWindow: count.optional(), supportsTools: z.boolean().optional(),
  supportedParameters: labels.optional(), inputModalities: labels.optional(), outputModalities: labels.optional(),
  visionInputCapability: z.enum(['supported', 'unsupported', 'unknown']).optional(),
  maxTurns: count.optional(), maxTokens: count.optional(), compactionThreshold: count.optional(),
  compactionThresholdPercent: z.number().min(1).max(100).optional(),
}).strict();
export const sharedModelDocumentSchema = z.object({ format: z.literal(SHARED_MODEL_FORMAT), model: sharedModelSchema }).strict();
export type SharedModelDocument = z.infer<typeof sharedModelDocumentSchema>;

export function modelConfigurationFields(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(sharedModelSchema.shape)
    .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
}

export function readSharedModel(value: unknown): SharedModelDocument {
  const result = sharedModelDocumentSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid shared model configuration. Credentials and private bindings are not supported.');
  return result.data;
}

/** Strip credentials, private IDs, folders and unknown fields before publication.
 * Owner-bound models and routing aliases require separate dependency grants. */
export function publishableModel(input: Record<string, unknown>): SharedModelDocument {
  if (input.ownerCredentialBinding !== undefined || input.fallbackPolicy !== undefined) {
    throw new Error('This model depends on a private credential binding or routing policy. Share its dependencies before publishing it.');
  }
  const model = modelConfigurationFields(input);
  return readSharedModel({ format: SHARED_MODEL_FORMAT, model });
}

// Keep the browser contract in this leaf module. Node-only entry points can
// re-export it with .js specifiers without making the app bundle resolve them.
export const teamResourceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const teamModelGeneration = z.string().regex(/^[a-f0-9]{64}$/);
export const teamModelReferenceSchema = z.object({ teamId: teamResourceId, resourceId: teamResourceId,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), generation: teamModelGeneration,
  teamName: z.string().min(1).max(80) }).strict();
export type TeamModelReference = z.infer<typeof teamModelReferenceSchema>;
export const teamModelSummarySchema = z.object({ reference: teamModelReferenceSchema,
  model: sharedModelSchema.pick({ name: true, displayName: true, provider: true, adapter: true,
    contextWindow: true, supportsTools: true, inputModalities: true, outputModalities: true,
    visionInputCapability: true, maxTokens: true }).strip() }).strict();
export const teamModelCatalogueSchema = z.object({ entries: z.array(teamModelSummarySchema).max(8), next: teamResourceId.nullable() }).strict();
export const resolvedTeamModelSchema = z.object({ reference: teamModelReferenceSchema, document: sharedModelDocumentSchema }).strict();
export const teamModelId = (reference: Pick<TeamModelReference, 'teamId' | 'resourceId'>): string => `team-model:${reference.teamId}:${reference.resourceId}`;
export function parseTeamModelId(id: string): { teamId: string; resourceId: string } | null {
  const match = /^team-model:([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})$/.exec(id);
  return match ? { teamId: match[1], resourceId: match[2] } : null;
}
export const teamModelBaseUrl = (reference: TeamModelReference): string =>
  `http://127.0.0.1:4290/teams/${reference.teamId}/${reference.resourceId}/revisions/${reference.version}/grants/${reference.generation}/v1`;
