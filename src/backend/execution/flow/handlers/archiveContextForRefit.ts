import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import { writeRunResource } from '@/backend/services/runResources';
import { commitFlowDurableMutation, type FlowDurableMutationContext } from '../executionAuthority';

// Search reads each source independently with a 16 MiB ceiling. Smaller leaves
// also permit bounded traversal/cursors without materializing a whole history.
const MAX_LEAF_BYTES = 4 * 1024 * 1024;
const MAX_CHILDREN = 32;

/** Immutable, searchable source for emergency omissions when a summarizer is
 * unavailable. Only the already-admitted provider projection is archived. */
export async function archiveContextForRefit(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  sourceIds: readonly (string | undefined)[],
  conversationId: string | undefined,
  nodeId: string | undefined,
  durableContext: FlowDurableMutationContext = {},
): Promise<string | undefined> {
  if (!conversationId) return undefined;
  type Source = OpenAI.ChatCompletionMessageParam & { id: string };
  type Child = { resourceUri: string; sourceMessageCount: number };
  const persist = async (payload: Source[] | { children: Child[] }, sourceMessageCount: number): Promise<Child> => {
    const text = JSON.stringify(payload);
    const digest = createHash('sha256').update(JSON.stringify([nodeId ?? null])).update(text).digest('hex');
    const name = 'context-refit-' + digest;
    // Same-node concurrent callers must receive the same immutable URI. Named
    // lookup followed by replacement would invalidate the first caller's source.
    const written = await commitFlowDurableMutation(durableContext, () => writeRunResource({
      conversationId, name, idempotencyKey: name, mimeType: 'application/json', kind: 'text',
      // Bounded JSON text uses the store's content-fingerprinted idempotency
      // path; its streamed generic JSON writer has no idempotency fingerprint.
      data: { text }, producedBy: { source: 'compaction-artifact', nodeId },
    }));
    if ('skipped' in written) throw new Error('Could not archive context before automatic refit.');
    return { resourceUri: written.uri, sourceMessageCount };
  };
  let children: Child[] = [];
  let chunk: Source[] = [], bytes = 2;
  for (let index = 0; index < messages.length; index++) {
    const message = { ...messages[index], id: sourceIds[index] ?? `context-message-${index}` } as Source;
    const size = Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
    if (size + 2 > MAX_LEAF_BYTES) {
      throw new Error('An individual history message cannot fit in a searchable recovery archive.');
    }
    if (chunk.length && bytes + size > MAX_LEAF_BYTES) {
      children.push(await persist(chunk, chunk.length));
      chunk = []; bytes = 2;
    }
    chunk.push(message); bytes += size;
  }
  if (chunk.length) children.push(await persist(chunk, chunk.length));
  if (!children.length) return undefined;
  while (children.length > 1) {
    const parents: Child[] = [];
    for (let index = 0; index < children.length; index += MAX_CHILDREN) {
      const group = children.slice(index, index + MAX_CHILDREN);
      parents.push(await persist({ children: group }, group.reduce((sum, child) => sum + child.sourceMessageCount, 0)));
    }
    children = parents;
  }
  return children[0].resourceUri;
}
