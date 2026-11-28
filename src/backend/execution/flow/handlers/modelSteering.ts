// Mid-run steering for agent SDK adapters: claim, send, acknowledge or return waiting messages.
import { takeSteeringMessages, requeueSteeringMessages, subscribeSteeringMessages, markSteeringDelivered } from '@/backend/execution/flow/steeringInbox';
import { isSelfOrchestratingAdapter, type ModelAdapter } from '@/shared/types/model/provider';
import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';
import type { ModelSteering } from '@/backend/services/model/adapters/types';
import { assertFlowExecutionCurrent, type FlowDurableMutationContext } from '@/backend/execution/flow/executionAuthority';
import type { FlowExecutionAuthority } from '../types';

/** What steering needs from the model call. */
export type ModelSteeringContext = {
  conversationId?: string;
  modelAdapter?: ModelAdapter;
  nodeId?: string;
  durableContext: FlowDurableMutationContext;
  executionAuthority?: FlowExecutionAuthority;
  flushLiveProjection: () => Promise<void>;
};

/**
 * Steering messages for a self-orchestrating adapter, which runs several
 * model and tool turns inside one call. Undefined for other adapters, whose
 * steering runFlow folds in between steps.
 */
export function createModelSteering(context: ModelSteeringContext): ModelSteering | undefined {
  const { conversationId, modelAdapter, nodeId, durableContext, executionAuthority, flushLiveProjection } = context;
  // Self-orchestrating SDK adapters own several model/tool turns inside one
  // createCompletion call, so runFlow cannot reach its between-step steering
  // drain while they are active. Claim a batch, persist it before sending,
  // then acknowledge acceptance or return it to the inbox on rejection.
  const steeringWorkspace = getCurrentWorkspace();
  const steering: ModelSteering | undefined = conversationId &&
    isSelfOrchestratingAdapter(modelAdapter)
    ? {
      take: () => runWithWorkspace(steeringWorkspace, async () => {
        await assertFlowExecutionCurrent(durableContext);
        await executionAuthority?.pollRelatedInputs?.();
        const pending = takeSteeringMessages(conversationId);
        if (!pending.length) return undefined;
        for (const message of pending) {
          if (!message.processNodeId && nodeId) message.processNodeId = nodeId;
        }
        let accepted = false;
        let returned = false;
        return {
          messages: pending,
          beforeSend: () => runWithWorkspace(steeringWorkspace, async () => {
            await flushLiveProjection();
            await assertFlowExecutionCurrent(durableContext);
          }),
          acknowledge: () => runWithWorkspace(steeringWorkspace, async () => {
            accepted = true;
            await flushLiveProjection();
            await assertFlowExecutionCurrent(durableContext);
            const ids = pending.map(message => message.id).filter(Boolean);
            markSteeringDelivered(conversationId, ids);
            if (ids.length) await executionAuthority?.acknowledgeRelatedInputs?.(ids);
          }),
          requeue: () => runWithWorkspace(steeringWorkspace, () => {
            if (accepted || returned) return;
            returned = true;
            requeueSteeringMessages(conversationId, pending);
          }),
        };
      }),
      subscribe: listener => runWithWorkspace(steeringWorkspace, () =>
        subscribeSteeringMessages(conversationId, listener)),
      }
    : undefined;

  return steering;
}
