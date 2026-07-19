/**
 * Issue #168 — resource-aware truncation markers in the Claude-subscription
 * adapter's flattened prompt.
 *
 * When a PRIOR tool result / tool-call args was too large to inline AND was
 * captured as a run resource, `buildUserMessage` renders a head excerpt plus a
 * dereferenceable `flujo://run/...` marker (which the model can read via the
 * `read_resource` tool) instead of a plain `…[truncated …]`. When there is no
 * captured entry — or the content fits — the output stays byte-identical to the
 * pre-#168 plain-truncation behaviour (prefix-cache stability). The current
 * node's live loop is never handed to this function, so only prior/settled
 * turns can ever be rewritten.
 */

// The adapter imports mcpService at module scope; stub it so importing the
// module (for the pure buildUserMessage export) never drags its dependency graph
// in. The Agent SDK itself is lazy-imported inside createCompletion, not here.
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { callTool: jest.fn() },
}));

import type OpenAI from 'openai';
import { buildUserMessage } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';
import type { ToolResourceMarker } from '@/backend/services/model/adapters/types';
import type { RunResourceEntry } from '@/shared/types/runResources';

const asString = (content: string | OpenAI.ChatCompletionContentPart[] | unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content);

const entry = (uri: string): RunResourceEntry =>
  ({ uri, id: uri.split('/').pop(), conversationId: 'conv-1', size: 99999, kind: 'text', encoding: 'utf8', createdAt: 1, producedBy: { source: 'tool-result' }, readBy: [] } as unknown as RunResourceEntry);

// A prior settled tool exchange: assistant(tool_call) + tool(result).
const toolHistory = (resultText: string, args = '{}'): OpenAI.ChatCompletionMessageParam[] => [
  { role: 'user', content: 'do the thing' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_big', arguments: args } }] },
  { role: 'tool', tool_call_id: 'call1', content: resultText },
];

describe('buildUserMessage resource-aware markers (#168)', () => {
  const BIG = 'A'.repeat(5000); // > TOOL_RESULT_MAX_CHARS (4000)

  it('renders a head excerpt + flujo:// marker for an oversized result WITH a captured entry', () => {
    const markers = new Map<string, ToolResourceMarker>([
      ['call1', { result: entry('flujo://run/conv-1/res-1') }],
    ]);
    const { content } = buildUserMessage(toolHistory(BIG), markers);
    const text = asString(content);
    expect(text).toContain('flujo://run/conv-1/res-1');
    expect(text).toContain('read_resource');
    // The tail is offloaded to the resource, NOT the plain truncation marker.
    expect(text).not.toContain('[truncated');
    // The head excerpt (first 4000 chars) is preserved verbatim.
    expect(text).toContain('A'.repeat(4000));
  });

  it('falls back to plain truncation for an oversized result WITHOUT an entry (byte-identical)', () => {
    const withoutMarkers = asString(buildUserMessage(toolHistory(BIG)).content);
    const withEmptyMarkers = asString(buildUserMessage(toolHistory(BIG), new Map()).content);
    expect(withoutMarkers).toBe(withEmptyMarkers);
    expect(withoutMarkers).toContain('[truncated');
    expect(withoutMarkers).not.toContain('flujo://run/');
  });

  it('does not add a marker when the result fits under the cap', () => {
    const small = 'short result';
    const markers = new Map<string, ToolResourceMarker>([
      ['call1', { result: entry('flujo://run/conv-1/res-1') }],
    ]);
    const text = asString(buildUserMessage(toolHistory(small), markers).content);
    expect(text).toContain('short result');
    expect(text).not.toContain('flujo://run/');
    expect(text).not.toContain('read_resource');
  });

  it('renders a marker for oversized tool-call ARGS with a captured args entry', () => {
    const bigArgs = JSON.stringify({ blob: 'B'.repeat(5000) }); // > TOOL_ARGS_MAX_CHARS (2000)
    const markers = new Map<string, ToolResourceMarker>([
      ['call1', { args: entry('flujo://run/conv-1/args-1') }],
    ]);
    const text = asString(buildUserMessage(toolHistory('ok', bigArgs), markers).content);
    expect(text).toContain('flujo://run/conv-1/args-1');
    expect(text).toContain('read_resource');
  });

  it('is byte-identical for a tool-free history regardless of the markers arg', () => {
    const plain: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hello world' }];
    expect(buildUserMessage(plain).content).toBe('hello world');
    expect(buildUserMessage(plain, new Map()).content).toBe('hello world');
  });
});
