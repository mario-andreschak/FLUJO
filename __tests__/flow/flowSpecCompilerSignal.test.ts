/**
 * Signal node (issue #117) in the FlowSpec codec.
 *
 * Pins: compile emits the signal FlowNode inline with STANDARD control edges
 * (a signal is a pass-through control node, not an attachment); a missing topic
 * is flagged; and — the AI-Improve data-loss guard — flowToSpec round-trips the
 * signal node's topic/payload instead of dropping it.
 */
import { compileFlowSpec, flowToSpec, FlowSpec } from '@/utils/shared/flowSpecCompiler';

const context = { models: [{ id: 'model-1', displayName: 'GPT' }], servers: [], serverTools: {} };

const signalSpec = (signal: Record<string, unknown>): FlowSpec => ({
  name: 'signal_flow',
  nodes: [
    { key: 'start', type: 'start', prompt: 'sys' },
    { key: 'sig', type: 'signal', ...signal } as never,
    { key: 'end', type: 'finish' },
  ],
  edges: [
    { from: 'start', to: 'sig' },
    { from: 'sig', to: 'end' },
  ],
});

describe('compile: signal nodes', () => {
  it('compiles a signal node inline with topic + payload and a standard control edge', () => {
    const result = compileFlowSpec(
      signalSpec({ topic: 'review-blocked', payloadTemplate: 'Blocked: ${var:reason}' }),
      context
    );
    expect(result.errorCount).toBe(0);
    const flow = result.flow!;
    const sig = flow.nodes.find((n) => n.type === 'signal')!;
    expect(sig.data.properties).toMatchObject({
      topic: 'review-blocked',
      payloadTemplate: 'Blocked: ${var:reason}',
    });

    // The outgoing edge is a normal control edge, NOT a resource/mcp attachment.
    const outgoing = flow.edges.find((e) => e.source === sig.id)!;
    expect((outgoing.data as { edgeType?: string })?.edgeType).toBe('standard');
    expect(outgoing.sourceHandle).toBe('signal-bottom');
  });

  it('warns when a signal node has no topic', () => {
    const result = compileFlowSpec(signalSpec({ payloadTemplate: 'x' }), context);
    expect(result.issues.some((i) => i.code === 'signal-missing-topic')).toBe(true);
  });

  it('flowToSpec round-trips a signal node (AI-Improve data-loss guard)', () => {
    const flow = compileFlowSpec(
      signalSpec({ topic: 'greet', payloadTemplate: 'Hi ${var:name}' }),
      context
    ).flow!;
    const back = flowToSpec(flow);
    const sig = back.nodes.find((n) => n.type === 'signal')!;
    expect(sig.topic).toBe('greet');
    expect(sig.payloadTemplate).toBe('Hi ${var:name}');
  });
});
