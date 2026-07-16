import { createLogger } from '@/utils/logger';
import { EmitFn, NodeRef } from '@/shared/types/execution/events';
import { findRunResourceByName, readRunResource } from '@/backend/services/runResources';

/**
 * `${res:NAME}` — inject a NAMED run-scoped resource into prompt text.
 *
 * The read-back side of `captureResource` (Tier 3), mirroring how
 * `${var:NAME}` (resolveRunVars) is the read-back side of `captureVariable`:
 * NAME is looked up in the conversation's run-resource store; text resources
 * are inlined as a delimited block, binary ones as a URI stub the model can
 * read back via the internal "flujo" MCP server. Unknown names resolve to ''
 * with a warning — same total semantics as resolveRunVars.
 *
 * Backend-only (unlike resolveRunVars) because resolution reads the store on
 * disk. Runs AFTER resolveRunVars; no recursive expansion — a resource whose
 * contents contain `${res:...}` or `${var:...}` is inlined verbatim.
 * `${res:...}` is invisible to the MCP pill scanner (PILL_SCAN only matches
 * tool:/resource:/legacy bodies), so the two never interfere.
 *
 * Each successful resolution appends `readBy` lineage and emits a
 * `resource:read` event (source 'res-ref') so the canvas can light up.
 */

const log = createLogger('backend/flow/execution/resolveRunResourceRefs');

/** Matches `${res:NAME}`. Same name charset as run vars (no `}` inside). */
export const RES_REF_SCAN = /\$\{res:([^}]+)\}/g;

/** Cheap pre-check so callers can skip the async path entirely. */
export function hasRunResourceRef(text: string): boolean {
  RES_REF_SCAN.lastIndex = 0;
  return RES_REF_SCAN.test(text);
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function resolveRunResourceRefs(
  text: string,
  conversationId: string | undefined,
  emit?: EmitFn,
  node?: NodeRef
): Promise<string> {
  if (!text || !text.includes('${res:') || !conversationId) {
    // No refs, or no conversation to resolve against (design-time render,
    // ephemeral child without a store): unknown-name semantics say ''.
    return text ? text.replace(RES_REF_SCAN, '') : text;
  }

  // Collect matches first (replace() can't await), then substitute.
  RES_REF_SCAN.lastIndex = 0;
  const names = new Set<string>();
  for (let m = RES_REF_SCAN.exec(text); m; m = RES_REF_SCAN.exec(text)) {
    names.add(m[1]);
  }

  const substitutions = new Map<string, string>();
  for (const name of names) {
    let value = '';
    try {
      const entry = await findRunResourceByName(conversationId, name.trim());
      if (!entry) {
        log.warn(`\${res:${name}} has no matching run resource; resolving to ''`, { conversationId });
      } else {
        const read = await readRunResource(entry.uri, {
          at: Date.now(),
          source: 'res-ref',
          nodeId: node?.nodeId,
        });
        if (read) {
          const item = read.contents.contents[0];
          if (item && typeof (item as { text?: unknown }).text === 'string' && entry.kind !== 'link') {
            // Same delimited framing as resource pills (renderResourceBinding).
            value = `\n--- resource ${name} (${entry.uri}) ---\n${(item as { text: string }).text}\n--- end resource ${name} ---\n`;
          } else {
            // Binary (or link): a stub the model can follow via MCP.
            value = `[run resource "${name}": ${entry.mimeType ?? entry.kind} (${formatKb(entry.size)}) at ${entry.uri} — readable via the 'flujo' MCP server]`;
          }
          emit?.({
            type: 'resource:read',
            node,
            server: 'flujo',
            uri: entry.uri,
            name,
            mimeType: entry.mimeType,
            size: entry.size,
            source: 'res-ref',
          });
        } else {
          log.warn(`\${res:${name}} entry exists but payload read failed; resolving to ''`, { uri: entry.uri });
        }
      }
    } catch (error) {
      // Resolution must never break a run.
      log.error(`Failed to resolve \${res:${name}}; resolving to ''`, error);
    }
    substitutions.set(name, value);
  }

  return text.replace(RES_REF_SCAN, (_full, name: string) => substitutions.get(name) ?? '');
}
