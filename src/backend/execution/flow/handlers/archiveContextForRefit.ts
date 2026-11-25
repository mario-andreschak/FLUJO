import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import { writeRunResource } from '@/backend/services/runResources';
import { commitFlowDurableMutation, type FlowDurableMutationContext } from '../executionAuthority';

// `read_resource` search reads each stored file with a 16 MiB ceiling; smaller
// leaves keep every read and cursor step well inside it.
const MAX_LEAF_BYTES = 4 * 1024 * 1024;
const MAX_CHILDREN = 32;

/**
 * Store the exact request a provider rejected as an immutable, searchable tree
 * (original roles and source IDs, at most 32 children per node), so decisions
 * the smaller retry leaves out can be found again with `read_resource`.
 * Identical content from the same node gets the same URI, even concurrently.
 */
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
    const name = 'context-refit-' + createHash('sha256').update(JSON.stringify([nodeId ?? null])).update(text).digest('hex');
    const written = await commitFlowDurableMutation(durableContext, () => writeRunResource({
      conversationId, name, idempotencyKey: name, mimeType: 'application/json', kind: 'text',
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
