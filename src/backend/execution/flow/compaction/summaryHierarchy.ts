import { createHash } from 'node:crypto';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { SummaryRange } from './types';
import { digestProjectedMessages } from './digest';

export type SummaryRangePayload = Omit<SummaryRange, 'resourceUri'> & {
  messages?: readonly FlujoChatMessage[];
  children?: readonly SummaryRange[];
};

/** Immutable source ranges form a balanced base-eight forest. Parent summaries
 * retain child locators; replacing a root never destroys its original leaves.
 * The small forest is persisted alongside the current conversation artifact. */
export async function appendSummaryRanges(input: {
  previous: readonly SummaryRange[];
  chunks: readonly FlujoChatMessage[][];
  inputBudget: number;
  summarize: (messages: FlujoChatMessage[], leaf: boolean) => Promise<string>;
  persist: (payload: SummaryRangePayload) => Promise<string | undefined>;
}): Promise<{ summaryText: string; ranges: SummaryRange[]; resourceUri: string }> {
  const ranges = input.previous.map(range => ({ ...range }));
  // Tiny model windows need fewer children per merge; retaining an unmergeable
  // base-eight frontier would grow without bound even with short summaries.
  const fanout = input.inputBudget < 32_000 ? 2 : 8;
  const save = async (payload: SummaryRangePayload): Promise<SummaryRange> => {
    const resourceUri = await input.persist(payload);
    if (!resourceUri) throw new Error('Summary range could not be persisted');
    const { messages: _messages, children: _children, ...metadata } = payload;
    return { ...metadata, resourceUri };
  };
  const merge = async (children: SummaryRange[]): Promise<SummaryRange> => {
    const messages = children.map((child, index): FlujoChatMessage => ({
      id: child.sourceDigest, role: 'assistant', timestamp: index,
      content: 'Historical range ' + child.sourceStartId + ' through ' + child.sourceEndId
        + '; exact children at ' + child.resourceUri + '\n' + child.summaryText,
    }));
    if (JSON.stringify(messages).length / 4 > input.inputBudget) throw new Error('Summary children exceed merge budget');
    const summaryText = await input.summarize(messages, false);
    return save({ level: Math.max(...children.map(child => child.level)) + 1,
      sourceStartId: children[0].sourceStartId, sourceEndId: children.at(-1)!.sourceEndId,
      sourceMessageCount: children.reduce((sum, child) => sum + child.sourceMessageCount, 0),
      sourceDigest: createHash('sha256').update(JSON.stringify(children.map(child => child.sourceDigest))).digest('hex'),
      summaryText, children });
  };
  for (const messages of input.chunks) {
    if (!messages.length) continue;
    const summaryText = await input.summarize(messages, true);
    ranges.push(await save({ level: 0, sourceStartId: messages[0].id, sourceEndId: messages.at(-1)!.id,
      sourceMessageCount: messages.length, sourceDigest: digestProjectedMessages(messages), summaryText, messages }));
    while (ranges.length >= fanout) {
      const siblings = ranges.slice(-fanout);
      if (!siblings.every(child => child.level === siblings[0].level)) break;
      if (JSON.stringify(siblings).length / 4 > input.inputBudget) break;
      const parent = await merge(siblings);
      ranges.splice(-fanout, fanout, parent);
    }
  }
  // Reduce a copy for the final bounded root, keeping the balanced frontier for
  // later appends. Token-bounded groups also handle unusually verbose summaries.
  let roots = ranges.slice();
  while (roots.length > 1) {
    const next: SummaryRange[] = [];
    for (let offset = 0; offset < roots.length;) {
      const children: SummaryRange[] = [];
      let tokens = 0;
      while (offset < roots.length && children.length < fanout) {
        const cost = Math.ceil(JSON.stringify(roots[offset]).length / 4) + 64;
        if (children.length && tokens + cost > input.inputBudget) break;
        children.push(roots[offset++]); tokens += cost;
      }
      next.push(children.length > 1 ? await merge(children) : children[0]);
    }
    if (next.length >= roots.length) throw new Error('Summary output is too large to reduce');
    roots = next;
  }
  if (!roots.length) throw new Error('Missing summary ranges');
  return { summaryText: roots[0].summaryText, ranges, resourceUri: roots[0].resourceUri };
}
