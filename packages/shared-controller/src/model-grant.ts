import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const grantId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const modelName = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const privatePath = z.string().refine(value => isAbsolute(value) && !value.includes('\0'));
export const modelGrantSchema = z.object({ id: grantId,
  endpoint: z.string().refine(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname)
        && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/v1'
        && url.href === value && Boolean(url.port);
    } catch { return false; }
  }),
  models: z.array(modelName).min(1).max(128).refine(values => new Set(values).size === values.length),
  bearerFile: privatePath.optional(), caFile: privatePath.optional(),
}).strict().refine(grant => !grant.caFile || grant.endpoint.startsWith('https:'));
export type ModelGrant = z.infer<typeof modelGrantSchema>;
export const modelGrantRevision = (grant: ModelGrant) => createHash('sha256').update(JSON.stringify(grant)).digest('hex');
export const MODEL_BODY_BYTES = 8 * 1024 * 1024;
export const MODEL_RESPONSE_BYTES = 64 * 1024 * 1024;
// Match FLUJO's ordinary local-model request ceiling, including slow inference.
export const MODEL_LIFETIME_MS = 5 * 60 * 60 * 1000;

const name = z.string().min(1).max(256);
const fn = z.object({ name, arguments: z.string() }).strict();
const part = z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('image_url'), image_url: z.object({
    // Inline images only: a model request cannot turn the host into a URL/file fetcher.
    url: z.string().regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }).strict() }).strict(),
]);
const message = z.object({ role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: z.union([z.string(), z.array(part).max(256), z.null()]).optional(), name: name.optional(), tool_call_id: name.optional(),
  tool_calls: z.array(z.object({ id: name, type: z.literal('function'), function: fn }).strict()).max(256).optional(),
  function_call: fn.optional(),
}).strict();
const declaration = z.object({ name, description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional() }).strict();
const chatBody = z.object({ model: modelName, messages: z.array(message).min(1).max(4096),
  stream: z.boolean().optional(), stream_options: z.object({ include_usage: z.boolean() }).strict().optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  n: z.number().int().min(1).max(16).optional(), stop: z.union([z.string(), z.array(z.string()).max(16)]).nullable().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(), frequency_penalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(), logprobs: z.boolean().optional(), top_logprobs: z.number().int().min(0).max(20).optional(),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  tools: z.array(z.object({ type: z.literal('function'), function: declaration }).strict()).max(256).optional(),
  functions: z.array(declaration).max(256).optional(), parallel_tool_calls: z.boolean().optional(),
  tool_choice: z.union([z.enum(['none', 'auto', 'required']), z.object({ type: z.literal('function'),
    function: z.object({ name }).strict() }).strict()]).optional(),
  function_call: z.union([z.enum(['none', 'auto']), z.object({ name }).strict()]).optional(),
  response_format: z.union([z.object({ type: z.enum(['text', 'json_object']) }).strict(),
    z.object({ type: z.literal('json_schema'), json_schema: z.object({ name, description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).strict() }).strict()]).optional(),
  user: z.string().max(256).optional(),
}).strict();
const tokens = z.array(z.number().int().nonnegative()).min(1);
const embeddingBody = z.object({ model: modelName,
  input: z.union([z.string(), z.array(z.string()).max(4096), tokens, z.array(tokens).max(4096)]),
  encoding_format: z.enum(['float', 'base64']).optional(), dimensions: z.number().int().positive().optional(),
  user: z.string().max(256).optional(),
}).strict();
export type ModelOperation = 'models' | 'chat' | 'embeddings';

export function admittedModelBody(grant: ModelGrant, operation: Exclude<ModelOperation, 'models'>, value: unknown): string {
  const body = operation === 'chat' ? chatBody.parse(value) : embeddingBody.parse(value);
  if (!grant.models.includes(body.model)) throw new Error('Model is not granted.');
  // Tool/response schemas may contain recursive structure, but external schema
  // references must not authorize host file/network reads by an upstream server.
  const queue: unknown[] = [body]; let count = 0;
  while (queue.length) {
    const item = queue.pop(); if (++count > 100_000) throw new Error('Model request is too complex.');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if ((key === '$ref' || key === '$dynamicRef') && (typeof child !== 'string' || !child.startsWith('#'))) {
        throw new Error('External schema references are not permitted.');
      }
      queue.push(child);
    }
  }
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > MODEL_BODY_BYTES) throw new Error('Model request is too large.');
  return encoded;
}
