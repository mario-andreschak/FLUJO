import { z } from 'zod';

// Browser-safe authored configuration. This document conveys no permission to
// launch a process, read an owner's files, or use another member's credentials.
export const SHARED_MCP_FORMAT = 'flujo.mcp.v1';
// Covers JSON escaping at every draft field's maximum length. Published
// resources still obey the controller's smaller 1 MiB document quota.
export const MCP_DRAFT_BYTES = 16 * 1024 * 1024;
const literal = (max: number) => z.string().max(max).refine(value =>
  !/[\x00-\x1f\x7f]/u.test(value) && !/\$\{(?:global|kv):/iu.test(value),
  'Use literal text without control characters or private variable bindings.');
const endpoint = (protocols: string[]) => literal(2048).refine(value => {
  if (!value) return true; // Incomplete drafts are allowed; publication checks below.
  try { const url = new URL(value); return protocols.includes(url.protocol) && !!url.hostname
    && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}, 'Use an endpoint without credentials, query parameters or fragments.');
const keys = (pattern: RegExp) => z.array(z.string().min(1).max(128).regex(pattern)).max(64)
  .refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length, 'Names must be unique.');

export const sharedMcpConfigurationSchema = z.object({
  name: literal(120),
  transport: z.enum(['stdio', 'sse', 'streamable', 'websocket']),
  command: literal(2048).optional(), args: z.array(literal(8192)).max(256).optional(),
  serverUrl: endpoint(['http:', 'https:']).optional(), websocketUrl: endpoint(['ws:', 'wss:']).optional(),
  // Names declare inputs to be supplied privately by each recipient. Values,
  // OAuth state, roots, launch/build/install hooks and tool presets are absent.
  environmentKeys: keys(/^[A-Za-z_][A-Za-z0-9_]*$/u).optional(),
  headerNames: keys(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u).optional(),
}).strict();
export const sharedMcpDraftSchema = z.object({ format: z.literal('flujo.mcp.draft.v1'),
  document: z.object({ format: z.literal(SHARED_MCP_FORMAT), mcp: z.object({
    name: z.string().max(120), transport: sharedMcpConfigurationSchema.shape.transport,
    command: z.string().max(2048).optional(), args: z.array(z.string().max(8192)).max(256).optional(),
    serverUrl: z.string().max(2048).optional(), websocketUrl: z.string().max(2048).optional(),
    environmentKeys: z.array(z.string().max(128)).max(64).optional(), headerNames: z.array(z.string().max(128)).max(64).optional(),
  }).strict() }).strict() }).strict();
export const sharedMcpDocumentSchema = z.object({ format: z.literal(SHARED_MCP_FORMAT), mcp: sharedMcpConfigurationSchema }).strict()
  .superRefine(({ mcp }, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!mcp.name.trim()) issue('Enter a server name.');
    if (mcp.transport === 'stdio') {
      if (!mcp.command?.trim()) issue('Enter the command to run.');
      if (mcp.serverUrl !== undefined || mcp.websocketUrl !== undefined || mcp.headerNames !== undefined) issue('A stdio server cannot contain remote settings.');
    } else {
      if (mcp.command !== undefined || mcp.args !== undefined || mcp.environmentKeys !== undefined) issue('A remote server cannot contain process settings.');
      if (mcp.transport === 'websocket') {
        if (!mcp.websocketUrl || mcp.serverUrl !== undefined || mcp.headerNames !== undefined) issue('Enter a WebSocket endpoint without HTTP settings.');
      } else if (!mcp.serverUrl || mcp.websocketUrl !== undefined) issue('Enter an HTTP endpoint without WebSocket settings.');
    }
  });
export type SharedMcpDocument = z.infer<typeof sharedMcpDocumentSchema>;
export function readSharedMcp(value: unknown): SharedMcpDocument {
  const parsed = sharedMcpDocumentSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid shared MCP configuration. Review the transport fields and remove credentials or private bindings.');
  return parsed.data;
}

/** Projection deliberately omits command and arguments: either can embed a
 * secret or an owner path. The member authors them again in the review form.
 * Omission reports contain field names only, never private field values. */
export function projectSharedMcp(input: Record<string, unknown>): { document: SharedMcpDocument; omitted: string[] } {
  const transport = sharedMcpConfigurationSchema.shape.transport.parse(input.transport);
  const mcp: SharedMcpDocument['mcp'] = { name: typeof input.name === 'string' ? input.name.slice(0, 120) : '', transport };
  const retained = new Set(['name', 'transport']);
  if (transport === 'stdio') { mcp.command = ''; mcp.args = []; }
  else {
    const key = transport === 'websocket' ? 'websocketUrl' : 'serverUrl';
    const parsed = sharedMcpConfigurationSchema.shape[key].safeParse(input[key]);
    mcp[key] = parsed.success ? parsed.data ?? '' : '';
    if (parsed.success) retained.add(key);
  }
  return { document: { format: SHARED_MCP_FORMAT, mcp },
    omitted: Object.keys(input).filter(key => !retained.has(key)).sort() };
}
