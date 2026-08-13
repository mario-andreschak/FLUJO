import type { Edge } from '@xyflow/react';
import type { Flow, FlowNode } from '@/shared/types/flow';

export const TUTORIAL_CHAT_NAME = 'Chat';
export const TUTORIAL_CHAT_PROMPT = 'Reply helpfully to the user.';
export const TUTORIAL_WEB_QUESTION = 'Hey! What happened on the internet today?';

export interface TutorialChatFlowResult {
  flow: Flow;
  processNodeId: string;
}

/** Build the small, readable Start → Ask AI → Finish agent used by Stage 1. */
export function buildTutorialChatFlow(
  modelId: string | undefined,
  idFactory: () => string,
): TutorialChatFlowResult {
  const now = Date.now();
  const flowId = idFactory();
  const startId = idFactory();
  const processId = idFactory();
  const finishId = idFactory();

  const nodes: FlowNode[] = [
    {
      id: startId,
      type: 'start',
      position: { x: 250, y: 80 },
      data: {
        label: 'Start Node',
        type: 'start',
        properties: { promptTemplate: '' },
      },
    },
    {
      id: processId,
      type: 'process',
      position: { x: 250, y: 260 },
      data: {
        label: 'Ask AI',
        type: 'process',
        properties: {
          promptTemplate: TUTORIAL_CHAT_PROMPT,
          inputMode: 'full-history',
          outputMode: 'latest-message',
          ...(modelId ? { boundModel: modelId } : {}),
        },
      },
    },
    {
      id: finishId,
      type: 'finish',
      position: { x: 250, y: 440 },
      data: {
        label: 'Finish Node',
        type: 'finish',
        properties: {},
      },
    },
  ];
  const edges: Edge[] = [
    {
      id: idFactory(),
      source: startId,
      sourceHandle: 'start-bottom',
      target: processId,
      targetHandle: 'process-top',
      type: 'flowEdge',
      data: { edgeType: 'flow' },
    },
    {
      id: idFactory(),
      source: processId,
      sourceHandle: 'process-bottom',
      target: finishId,
      targetHandle: 'finish-top',
      type: 'flowEdge',
      data: { edgeType: 'flow' },
    },
  ];

  return {
    processNodeId: processId,
    flow: {
      id: flowId,
      name: TUTORIAL_CHAT_NAME,
      description: 'A friendly agent for everyday conversations.',
      favorite: true,
      createdAt: now,
      updatedAt: now,
      nodes,
      edges,
    } as Flow,
  };
}

export function findTutorialChatFlow(flows: Flow[]): TutorialChatFlowResult | null {
  const flow = flows.find(candidate => candidate.name.trim().toLocaleLowerCase() === 'chat');
  if (!flow) return null;
  const process = flow.nodes.find(node => node.data.type === 'process');
  if (!process) return null;
  return { flow, processNodeId: process.id };
}
