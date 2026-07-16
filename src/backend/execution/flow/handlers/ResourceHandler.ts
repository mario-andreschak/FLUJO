import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { findRunResourceByName, readRunResource } from '@/backend/services/runResources';
import { ResourceNodeReference } from '../types';
import { EmitFn } from '@/shared/types/execution/events';

/**
 * ResourceHandler (Tier 3) — the resource-node sibling of ToolHandler.
 *
 * At ProcessNode.prep, every CONSUME-role resource node folded onto the step
 * by FlowConverter is read and rendered into a "## Resources" context block
 * appended to the step's system prompt: static MCP resources via
 * mcpService.readResource (which also serves flujo://run/... through the
 * internal server), run artifacts by name via the run-resource store. Binary
 * contents become a URI stub, never inlined base64.
 *
 * Each successful read emits `resource:read` with source 'node' and the
 * RESOURCE node's id — that attribution is what lets the canvas light up the
 * resource node itself rather than the process node.
 *
 * Reads must never break a run: any failure renders a visible note in the
 * block instead of throwing.
 */

const log = createLogger('backend/flow/execution/handlers/ResourceHandler');

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ResourceContentsLike = { contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }> };

function renderContents(label: string, sourceDesc: string, data: ResourceContentsLike): string {
  const items = Array.isArray(data?.contents) ? data.contents : [];
  if (items.length === 0) return `### ${label}\n(empty resource — ${sourceDesc})\n`;
  const body = items
    .map((c) => {
      if (typeof c.text === 'string') return c.text;
      if (typeof c.blob === 'string') {
        const kb = Math.round((c.blob.length * 3 / 4) / 1024);
        return `[binary ${c.mimeType || 'data'} (~${kb} KB)${c.uri ? ` at ${c.uri}` : ''} — not inlined; readable via MCP resources/read]`;
      }
      return JSON.stringify(c);
    })
    .join('\n\n');
  return `### ${label} (${sourceDesc})\n${body}\n`;
}

export class ResourceHandler {
  /**
   * Read every consume-role resource node and render the context block.
   * Returns '' when there is nothing to inject.
   */
  static async processResourceNodes(input: {
    resourceNodes: ResourceNodeReference[];
    /** Owning conversation — needed to resolve run artifacts by name.
     *  Absent (ephemeral/legacy) ⇒ run artifacts render a note. */
    conversationId?: string;
    emit?: EmitFn;
  }): Promise<string> {
    const consumed = (input.resourceNodes ?? []).filter((r) => r.role === 'consume');
    if (consumed.length === 0) return '';

    const sections: string[] = [];
    for (const ref of consumed) {
      const props = ref.properties ?? {};
      const label = props.name || props.runName || props.uri || ref.id;
      try {
        if (props.scope === 'run') {
          const runName = props.runName?.trim();
          if (!runName) {
            sections.push(`### ${label}\n(run artifact with no name — configure the resource node)\n`);
            continue;
          }
          if (!input.conversationId) {
            sections.push(`### ${label}\n(run artifact "${runName}" is not available in this run)\n`);
            continue;
          }
          const entry = await findRunResourceByName(input.conversationId, runName);
          if (!entry) {
            // Expected on the first run before the producer step has executed.
            sections.push(`### ${label}\n(run artifact "${runName}" has not been produced yet)\n`);
            continue;
          }
          const read = await readRunResource(entry.uri, { at: Date.now(), source: 'node', nodeId: ref.id });
          if (!read) {
            sections.push(`### ${label}\n(run artifact "${runName}" could not be read)\n`);
            continue;
          }
          sections.push(renderContents(label, entry.uri, read.contents as ResourceContentsLike));
          input.emit?.({
            type: 'resource:read',
            node: { nodeId: ref.id, nodeName: props.name, nodeType: 'resource' },
            server: 'flujo',
            uri: entry.uri,
            name: runName,
            mimeType: entry.mimeType,
            size: entry.size,
            source: 'node',
          });
        } else {
          const server = props.boundServer;
          const uri = props.uri;
          if (!server || !uri) {
            sections.push(`### ${label}\n(resource node is not fully bound — set server and uri)\n`);
            continue;
          }
          const result = await mcpService.readResource(server, uri);
          if (!result.success || !result.data) {
            sections.push(`### ${label}\n(resource ${uri} on ${server} could not be read: ${result.error ?? 'unknown error'})\n`);
            continue;
          }
          sections.push(renderContents(label, `${uri} from ${server}`, result.data as ResourceContentsLike));
          const first = (result.data as ResourceContentsLike).contents?.[0];
          input.emit?.({
            type: 'resource:read',
            node: { nodeId: ref.id, nodeName: props.name, nodeType: 'resource' },
            server,
            uri,
            name: props.name,
            mimeType: first?.mimeType ?? props.mimeType,
            size: typeof first?.text === 'string' ? first.text.length
              : typeof first?.blob === 'string' ? Math.floor(first.blob.length * 3 / 4)
              : undefined,
            source: 'node',
          });
        }
      } catch (error) {
        log.error(`Failed to read resource node ${ref.id}; injecting a note`, error);
        sections.push(`### ${label}\n(resource is currently unavailable)\n`);
      }
    }

    return `\n\n## Resources\nThe following data artifacts are wired to this step:\n\n${sections.join('\n')}`;
  }
}
