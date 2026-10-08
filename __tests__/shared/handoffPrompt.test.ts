import type { Edge } from '@xyflow/react';
import type { FlowNode } from '@/shared/types/flow';
import { reconcileHandoffPromptForTopologyChange } from '@/utils/shared/handoffPrompt';

const node = (id: string, type: string, label: string): FlowNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { type: type as FlowNode['data']['type'], label, properties: {} },
});

const edge = (id: string, source: string, target: string, bidirectional = false): Edge => ({
  id,
  source,
  target,
  data: { edgeType: 'standard', ...(bidirectional ? { bidirectional: true } : {}) },
});

describe('reconcileHandoffPromptForTopologyChange', () => {
  it('replaces Finish with the newly inserted follow-up and preserves agent routing', () => {
    const process = node('work', 'process', 'Work');
    const finish = node('finish', 'finish', 'Finish');
    const writer = node('writer', 'subflow', 'Writer');
    const review = node('review', 'process', 'Review');
    const previousNodes = [process, finish, writer];
    const previousEdges = [
      edge('finish-edge', 'work', 'finish'),
      edge('writer-edge', 'work', 'writer', true),
    ];
    const nextNodes = [process, finish, writer, review];
    const nextEdges = [
      edge('writer-edge', 'work', 'writer', true),
      edge('review-edge', 'work', 'review'),
    ];
    const prompt = [
      'Prepare the material.',
      '',
      'Handoff conditions:',
      '- When this step is complete, hand off to ${tool:handoff__handoff_to_finish}.',
      '- When a polished draft is needed, hand off to ${tool:handoff__handoff_to_writer}.',
    ].join('\n');

    const result = reconcileHandoffPromptForTopologyChange({
      prompt,
      nodeId: 'work',
      previous: { nodes: previousNodes, edges: previousEdges },
      next: { nodes: nextNodes, edges: nextEdges },
    });

    expect(result).not.toContain('handoff_to_finish');
    expect(result).toContain('When this step is complete, hand off to ${tool:handoff__handoff_to_review}.');
    expect(result).toContain('When a polished draft is needed, hand off to ${tool:handoff__handoff_to_writer}.');
  });

  it('adds a deterministic section when the prior prompt had no handoff pills', () => {
    const process = node('work', 'process', 'Work');
    const finish = node('finish', 'finish', 'Finish');
    const review = node('review', 'process', 'Review');

    const result = reconcileHandoffPromptForTopologyChange({
      prompt: 'Prepare the material.',
      nodeId: 'work',
      previous: { nodes: [process, finish], edges: [edge('old', 'work', 'finish')] },
      next: { nodes: [process, finish, review], edges: [edge('new', 'work', 'review')] },
    });

    expect(result).toContain('Handoff conditions:');
    expect(result).toContain('${tool:handoff__handoff_to_review}');
    expect(result).not.toContain('handoff_to_finish');
  });
});
