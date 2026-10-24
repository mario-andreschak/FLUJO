import { createLogger } from '@/utils/logger';
import {
  commitFlowDurableMutation,
  rethrowFlowExecutionAuthorityError,
  type FlowDurableMutationContext,
} from '@/backend/execution/flow/executionAuthority';
import {
  writeRunResource,
  readRunResourceBounded,
  parseRunResourceUri,
  getRunResourceLocalPath,
} from '@/backend/services/runResources';
import { ToolDefinition, ResourceNodeReference, MCPNodeReference } from '../types';
import { EmitFn, NodeRef } from '@/shared/types/execution/events';
import { RUN_RESOURCE_SCHEME } from '@/shared/types/runResources';
import { executeNativeReadResource } from './mcpResourceTools';
import sharp from 'sharp';
import path from 'node:path';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { prepareImageInput } from './prepareImageInput';
import { searchCompactionResource } from '@/backend/services/runResources/searchCompactionResource';

/**
 * Run-resource tools (Tier 3, issue #161).
 *
 * The produce side of a resource node used to be a PASSIVE capture of the
 * process node's final assistant text (ProcessNode.post → captureResource).
 * In a multi-node flow the first step usually HANDS OFF, so its final content
 * is empty and the capture wrote an empty artifact — the reported "artifacts
 * don't work" bug. The passive path was removed in favour of an EXPLICIT
 * `write_resource` tool: when a PRODUCE-role run-artifact resource node is
 * wired to a step, the step's model is given a tool it can call to write the
 * artifact's real content, matching how a model actually behaves when asked to
 * "produce an artifact".
 *
 * The tool is only OFFERED when such a node is wired (mirrors how mcpNodes gate
 * MCP tools), so byte-identical prompts/tools survive for flows that don't use
 * resources (preserving the #89 provider prefix-cache stability). External /
 * MCP-provided resources stay read-only — this only writes run-scoped artifacts
 * owned by the current conversation.
 *
 * Both tool-loop implementations use this module: the request/response path
 * (ModelHandler.processToolCalls) intercepts the tool by name and calls
 * `executeRunResourceTool`; the self-orchestrating Claude-subscription adapter
 * receives a `localToolExecutors` entry built from the same function.
 */

const log = createLogger('backend/flow/execution/handlers/runResourceTools');

export const WRITE_RESOURCE_TOOL_NAME = 'write_resource';
export const READ_RESOURCE_TOOL_NAME = 'read_resource';

/** True for any synthetic run-resource tool (dispatched here, not via mcpService). */
export function isRunResourceToolName(name: string): boolean {
  return name === WRITE_RESOURCE_TOOL_NAME || name === READ_RESOURCE_TOOL_NAME;
}

/**
 * The `read_resource` tool (issue #168). Dereferences a `flujo://run/...` URI
 * to its FULL content — the counterpart to the resource-aware truncation
 * markers the Claude-subscription adapter emits when a prior tool result/args
 * was too large to inline. DETERMINISTIC by construction (fixed name /
 * description / schema, no per-run interpolation) so that, once a run has
 * produced a resource, the tool set stays byte-identical turn to turn
 * (preserving the #89 provider prefix-cache). Auto-exposed by ProcessNode.prep
 * only when the wire history actually contains a `flujo://run/` URI.
 */
export function buildReadResourceTool(): ToolDefinition {
  return {
    name: READ_RESOURCE_TOOL_NAME,
    description:
      'Read flujo://run/... resources, native MCP URIs or bound files. search_text finds exact original messages beneath archived summaries. Images return pixels; use image_region to inspect fine details. Quote recovered identifiers verbatim, including their prefixes and punctuation.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'Resource URI or bound file path.',
        },
        max_chars: {
          type: 'integer',
          minimum: 1,
          maximum: 200000,
          description: 'UTF-16 text limit; default 50000.',
        },
        start_char: {
          type: 'integer',
          minimum: 0,
          description: 'Stored-text offset; continue with range.nextChar.',
        },
        expected_sha256: {
          type: 'string',
          description: 'Verify the immutable payload digest.',
        },
        search_text: {
          type: 'string', minLength: 1, maxLength: 512,
          description: 'Case-sensitive literal text search or exact source message ID lookup in archived originals.',
        },
        start_message: {
          type: 'integer', minimum: 0,
          description: 'Continue an incomplete search using next_message.',
        },
        image_region: {
          type: 'object', additionalProperties: false,
          description: 'Crop in auto-oriented original pixels; omit for overview.',
          properties: {
            left: { type: 'integer', minimum: 0 }, top: { type: 'integer', minimum: 0 },
            width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 },
          }, required: ['left', 'top', 'width', 'height'],
        },
      },
      required: ['uri'],
    },
  };
}

/**
 * Synthesize the run-resource tool definitions for a step from the resource
 * nodes FlowConverter folded onto it. Only PRODUCE-role run artifacts (scope
 * 'run' with a runName) yield a `write_resource` tool. Returns [] when nothing
 * is wired, so a step without a produce node is byte-identical to before.
 */
export function buildRunResourceTools(
  resourceNodes: ResourceNodeReference[] | undefined,
): ToolDefinition[] {
  const produce = (resourceNodes ?? []).filter(
    (r) => r.role === 'produce' && r.properties?.scope === 'run' && !!r.properties?.runName?.trim(),
  );
  if (produce.length === 0) return [];

  // De-dupe names (two produce edges could target the same artifact name).
  const names = Array.from(new Set(produce.map((r) => r.properties!.runName!.trim())));
  const quoted = names.map((n) => `"${n}"`).join(', ');

  return [{
    name: WRITE_RESOURCE_TOOL_NAME,
    description:
      'Produce/update a run artifact — a named data output of this flow run that later steps can read via ' +
      '${res:NAME} and that appears in the run-data panel. Write the artifact\'s FULL content here rather than ' +
      `only describing it in your reply. This step is wired to produce: ${quoted}. ` +
      'Writing the same name again replaces the previous content (last write wins).',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: `The artifact name to write. Use one of: ${names.join(', ')}.`,
        },
        content: {
          type: 'string',
          description: 'The full content of the artifact (text/markdown).',
        },
      },
      required: ['name', 'content'],
    },
  }];
}

export interface RunResourceToolContext extends FlowDurableMutationContext {
  /** Bound image views for native SDK loops as well as ordinary model calls. */
  maxImageTokens?: number;
  /** Owning conversation — run resources are scoped to it. Absent ⇒ refused. */
  conversationId?: string;
  /** Whether this is an ephemeral (subflow-child) run — those never persist resources. */
  ephemeral?: boolean;
  /** Producing process node, recorded as lineage + carried on the emitted event. */
  node?: NodeRef;
  emit?: EmitFn;
  /** Bound MCP nodes for native URI dispatch (issue #239). When provided,
   *  read_resource will also resolve non-flujo://run/ URIs against bound servers. */
  mcpNodes?: MCPNodeReference[];
}

export interface RunResourceToolOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
  media?: ModelMediaPart[];
}

/** Native adapters receive actual MCP image blocks, never base64 in JSON text. */
export function nativeRunResourceResult(outcome: RunResourceToolOutcome): unknown {
  if (!outcome.media?.length) return outcome.data;
  return { content: [{ type: 'text', text: JSON.stringify(outcome.data) },
    ...outcome.media.filter(part => part.type === 'image' && part.data)
      .map(part => ({ type: 'image', mimeType: part.mimeType ?? 'image/png', data: part.data! }))] };
}

/**
 * Execute one run-resource tool call. Never throws — always resolves to an
 * outcome the caller turns into a tool-result message (mirroring how a real
 * MCP tool error becomes an isError result).
 */
export async function executeRunResourceTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: RunResourceToolContext,
): Promise<RunResourceToolOutcome> {
  if (toolName === READ_RESOURCE_TOOL_NAME) {
    return executeReadResource(args, ctx);
  }
  if (toolName !== WRITE_RESOURCE_TOOL_NAME) {
    return { success: false, error: `Unknown run-resource tool: ${toolName}` };
  }
  if (!ctx.conversationId || ctx.ephemeral) {
    return { success: false, error: 'Run artifacts are not available in this run.' };
  }
  const name = typeof args?.name === 'string' ? args.name.trim() : '';
  if (!name) {
    return { success: false, error: 'write_resource requires a non-empty "name".' };
  }
  const content = typeof args?.content === 'string' ? args.content : '';

  try {
    return await commitFlowDurableMutation(ctx, async () => {
      const written = await writeRunResource({
        conversationId: ctx.conversationId!,
        name,
        mimeType: 'text/markdown',
        kind: 'text',
        data: { text: content },
        producedBy: {
          source: 'capture',
          nodeId: ctx.node?.nodeId,
          nodeName: ctx.node?.nodeName,
        },
      });
      if ('skipped' in written) {
        log.warn('write_resource skipped by store cap', { name, reason: written.skipped });
        return { success: false, error: `Artifact not stored (${written.skipped}).` };
      }
      ctx.emit?.({
        type: 'resource:write',
        node: ctx.node,
        server: 'flujo',
        uri: written.uri,
        name,
        mimeType: written.mimeType,
        size: written.size,
        source: 'capture',
      });
      log.info('write_resource stored run artifact', { name, uri: written.uri, size: written.size });
      return { success: true, data: { written: true, name, uri: written.uri, size: written.size } };
    });
  } catch (error) {
    rethrowFlowExecutionAuthorityError(error);
    log.error('write_resource failed', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Execute a `read_resource` call: dereference a `flujo://run/...` URI to its
 * full stored content, append the read to the resource's lineage (source
 * 'tool-read') and emit a `resource:read` event. Never throws. A URI belonging
 * to a DIFFERENT conversation is refused when a conversationId is in scope —
 * run resources are conversation-scoped, so a model can only dereference the
 * markers of its own run.
 */
async function executeReadResource(
  args: Record<string, unknown>,
  ctx: RunResourceToolContext,
): Promise<RunResourceToolOutcome> {
  let uri = typeof args?.uri === 'string' ? args.uri.trim() : '';
  if (!uri) {
    return { success: false, error: 'read_resource requires a non-empty "uri".' };
  }
  // Recover a mistyped scheme only when the complete, unchanged locator names
  // this conversation. Never fuzzy-match resource IDs or cross a run boundary.
  // A bound native server may own a similar scheme, so leave its URIs alone.
  if (ctx.conversationId && !ctx.mcpNodes?.length && !uri.startsWith(RUN_RESOURCE_SCHEME)) {
    const match = /^([a-z]+):\/\/run\/(.+)$/i.exec(uri);
    if (match && isSingleSchemeTypo(match[1].toLowerCase(), 'flujo')) {
      const candidate = RUN_RESOURCE_SCHEME + match[2];
      if (parseRunResourceUri(candidate)?.conversationId === ctx.conversationId) {
        log.info('Recovered run-resource scheme transcription', { originalUri: uri, uri: candidate });
        uri = candidate;
      }
    }
  }
  const parsed = parseRunResourceUri(uri);
  if (!parsed) {
    // The run-resource scheme is reserved for FLUJO. Malformed values must
    // fail here rather than falling through to native MCP advertisement, which
    // would produce the misleading "no server advertises this resource" error.
    if (uri.startsWith(RUN_RESOURCE_SCHEME)) {
      return { success: false, error: `Invalid run-resource URI: ${uri}` };
    }
    // Non-FLUJO URIs may be served by a native MCP server.
    if (ctx.mcpNodes && ctx.mcpNodes.length > 0) {
      return executeNativeReadResource(uri, {
        conversationId: ctx.conversationId,
        nodeId: ctx.node?.nodeId,
        ephemeral: ctx.ephemeral,
        mcpNodes: ctx.mcpNodes,
        emit: ctx.emit,
        node: ctx.node,
        executionAuthority: ctx.executionAuthority,
        personaAttribution: ctx.personaAttribution,
      });
    }
    return { success: false, error: `Not a run-resource URI: ${uri}` };
  }
  if (ctx.conversationId && parsed.conversationId !== ctx.conversationId) {
    return { success: false, error: `Run resource ${uri} is not part of this run.` };
  }

  try {
    return await commitFlowDurableMutation(ctx, async () => {
      const maxChars = typeof args?.max_chars === 'number' && Number.isFinite(args.max_chars)
        ? Math.floor(args.max_chars)
        : undefined;
      const expectedSha256 = typeof args?.expected_sha256 === 'string'
        ? args.expected_sha256.trim()
        : undefined;
      const startChar = args?.start_char === undefined ? 0 : args.start_char;
      if (typeof startChar !== 'number' || !Number.isSafeInteger(startChar) || startChar < 0) {
        return { success: false, error: 'start_char must be a non-negative safe integer.' };
      }
      const access = { at: Date.now(), source: 'tool-read' as const, nodeId: ctx.node?.nodeId };
      const bounded = await readRunResourceBounded(uri, { maxChars, startChar, expectedSha256, access });
      if (!bounded) {
        return { success: false, error: `Run resource not found: ${uri}` };
      }
      if (bounded.verification?.ok === false) {
        return { success: false, error: 'The resource SHA-256 does not match the expected archived payload.' };
      }
      const entry = bounded.entry;
      ctx.emit?.({
        type: 'resource:read',
        node: ctx.node,
        server: 'flujo',
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
        size: entry.size,
        source: 'tool-read',
      });
      if (args.search_text !== undefined) {
        if (!ctx.conversationId || typeof args.search_text !== 'string' || args.image_region !== undefined) {
          return { success: false, error: 'Search requires conversation ownership and text, without image_region.' };
        }
        return { success: true, data: await searchCompactionResource({ uri, conversationId: ctx.conversationId,
          text: args.search_text, startMessage: (args.start_message ?? 0) as number, maxChars: maxChars ?? 12_000 }) };
      }
      // Prefer text content; for binary/link kinds return a compact note rather
      // than re-inlining base64 (which would defeat the point of the marker).
      const content = bounded.content;
      const localPath = entry.kind !== 'text' && entry.kind !== 'link'
        ? await getRunResourceLocalPath(entry.uri)
        : null;
      let media: ModelMediaPart[] | undefined;
      let imageView: { originalWidth: number; originalHeight: number; region: { left: number; top: number; width: number; height: number } } | undefined;
      if (localPath && entry.mimeType?.startsWith('image/')) {
        // libvips' Windows file loader needs the extended pathname form beyond
        // MAX_PATH, even though Node successfully found the same stored file.
        const decoder = sharp(path.toNamespacedPath(localPath), { limitInputPixels: 268_402_689, sequentialRead: true }).autoOrient();
        const metadata = await decoder.metadata();
        const width = metadata.autoOrient?.width ?? metadata.width;
        const height = metadata.autoOrient?.height ?? metadata.height;
        if (!width || !height) return { success: false, error: 'Image dimensions are unavailable.' };
        const region = (args.image_region ?? { left: 0, top: 0, width, height }) as Record<string, unknown>;
        if (!region || typeof region !== 'object' || ['left', 'top', 'width', 'height'].some(key =>
          typeof region[key] !== 'number' || !Number.isSafeInteger(region[key]) || Number(region[key]) < (key === 'width' || key === 'height' ? 1 : 0))
          || Number(region.left) + Number(region.width) > width || Number(region.top) + Number(region.height) > height) {
          return { success: false, error: `image_region must be inside the original ${width} by ${height} pixels.` };
        }
        const crop = region as { left: number; top: number; width: number; height: number };
        const pixels = await decoder.extract(crop).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
        const prepared = await prepareImageInput([{ role: 'user', content: [{ type: 'image_url', image_url: {
          url: 'data:image/png;base64,' + pixels.toString('base64'),
        } }] }], { maxImageTokens: ctx.maxImageTokens ?? 8192 });
        const part = prepared[0].content;
        const url = Array.isArray(part) && part.find(item => item.type === 'image_url');
        if (url && url.type === 'image_url') {
          const [prefix, data] = url.image_url.url.split(',', 2);
          media = [{ type: 'image', mimeType: prefix.slice(5).split(';')[0], data }];
        }
        imageView = { originalWidth: width, originalHeight: height, region: crop };
      }
      log.info('read_resource served run resource', { uri: entry.uri, size: entry.size });
      return {
        success: true,
        ...(media ? { media } : {}),
        // A cropped image already carries native pixels. Keep its exact source
        // identity and coordinates, without duplicating the binary placeholder,
        // generated storage name and original host path in a small model window.
        data: imageView && args.image_region ? {
          uri: entry.uri,
          sha256: entry.sha256,
          imageView,
        } : {
          uri: entry.uri,
          name: entry.name,
          mimeType: entry.mimeType,
          content,
          truncated: bounded.truncated,
          sha256: entry.sha256,
          verification: bounded.verification,
          range: bounded.range,
          ...(localPath ? { localPath } : {}),
          ...(imageView ? { imageView } : {}),
        },
      };
    });
  } catch (error) {
    rethrowFlowExecutionAuthorityError(error);
    log.error('read_resource failed', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One insertion, deletion, substitution or adjacent transposition. Restrict
 * this to the fixed scheme; identifiers and paths always remain exact. */
function isSingleSchemeTypo(value: string, expected: string): boolean {
  if (Math.abs(value.length - expected.length) > 1 || value === expected) return false;
  let first = 0;
  while (first < Math.min(value.length, expected.length) && value[first] === expected[first]) first++;
  if (value.length > expected.length) return value.slice(first + 1) === expected.slice(first);
  if (value.length < expected.length) return value.slice(first) === expected.slice(first + 1);
  return value.slice(first + 1) === expected.slice(first + 1)
    || (value[first] === expected[first + 1] && value[first + 1] === expected[first]
      && value.slice(first + 2) === expected.slice(first + 2));
}
