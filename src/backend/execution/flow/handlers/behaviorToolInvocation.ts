import { createHash } from 'crypto';

import type { PersonaBehaviorComposition } from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';

import type { ToolDefinition } from '../types';

const log = createLogger('backend/flow/execution/handlers/behaviorToolInvocation');

export const BEHAVIOR_TOOL_PREFIX = 'call_behavior_';

export interface BehaviorToolTarget {
  personaId: string;
  behaviorId: string;
  name: string;
  description: string;
}

export type BehaviorToolRegistry = Record<string, BehaviorToolTarget>;

export function isBehaviorToolName(name: string): boolean {
  return name.startsWith(BEHAVIOR_TOOL_PREFIX);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function stableSuffix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Friendly names use Behavior metadata plus an immutable binding-derived suffix.
 * Flow title edits and changes to the surrounding Behavior set cannot rename a
 * previously advertised callable.
 */
export function buildBehaviorToolRegistry(input: {
  personaId: string;
  behaviors: readonly PersonaBehaviorComposition[];
  excludeBehaviorId?: string;
}): BehaviorToolRegistry {
  const registry: BehaviorToolRegistry = {};
  const ordered = [...input.behaviors]
    .filter((behavior) => behavior.ref !== input.excludeBehaviorId)
    .sort((left, right) => left.ref.localeCompare(right.ref));

  for (const behavior of ordered) {
    const name = `${BEHAVIOR_TOOL_PREFIX}${slug(behavior.name) || 'behavior'}_`
      + stableSuffix(behavior.ref);
    registry[name] = {
      personaId: input.personaId,
      behaviorId: behavior.ref,
      name: behavior.name,
      description: `Run the Persona Behavior "${behavior.name}" and return its Flow result.`,
    };
  }
  return registry;
}

export function buildBehaviorToolDefinitions(
  registry: BehaviorToolRegistry | undefined,
): ToolDefinition[] {
  if (!registry) return [];
  return Object.entries(registry).map(([name, target]) => ({
    name,
    description:
      `${target.description}\n\nCALLABLE BEHAVIOR: this invokes the Behavior's currently selected `
      + 'Persona replacement Flow, or its shared source Flow when no replacement is selected. '
      + 'The selected Flow is pinned before execution and the result is returned here.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Task or input to pass to the Behavior Flow.',
        },
      },
      required: ['task'],
    },
  }));
}

export interface BehaviorToolCallOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

export async function executeBehaviorToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: {
    conversationId?: string;
    toolCallId?: string;
    emit?: (event: any) => void;
  },
): Promise<BehaviorToolCallOutcome> {
  let durablePin:
    import('@/backend/services/enduringAgents/behaviorCallPins').BehaviorCallPin | undefined;
  let authority: import('../types').FlowExecutionAuthority | undefined;

  try {
    if (!ctx.conversationId) {
      return { success: false, error: 'No active Persona conversation for this Behavior call.' };
    }
    const { FlowExecutor } = await import('../FlowExecutor');
    const sharedState = FlowExecutor.conversationStates.get(ctx.conversationId);
    if (!sharedState) {
      return { success: false, error: 'Live Persona state not found for this Behavior call.' };
    }

    const target = sharedState.behaviorToolRegistry?.[name];
    if (!target) {
      return { success: false, error: `Unknown Behavior tool ${JSON.stringify(name)}.` };
    }
    const attribution = sharedState.personaAttribution;
    if (
      !attribution?.activityId
      || !attribution.behaviorRevisionId
      || attribution.personaId !== target.personaId
      || !sharedState.executionAuthority?.commitWhileCurrent
    ) {
      return { success: false, error: 'Behavior tool is not authorized for this Persona Activity.' };
    }

    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) return { success: false, error: 'Behavior call requires a non-empty task.' };

    authority = sharedState.executionAuthority;
    const fallbackCallKey = createHash('sha256')
      .update(JSON.stringify({
        conversationId: ctx.conversationId,
        logicalRunId: sharedState.logicalRunId,
        behaviorId: target.behaviorId,
        task,
      }))
      .digest('hex');
    const callKey = ctx.toolCallId ?? fallbackCallKey;
    const {
      behaviorCallPinId,
      completeBehaviorCallPin,
      createBehaviorCallPin,
      getBehaviorCallPin,
    } = await import('@/backend/services/enduringAgents/behaviorCallPins');
    const pinId = behaviorCallPinId({
      personaId: target.personaId,
      activityId: attribution.activityId,
      parentBehaviorRevisionId: attribution.behaviorRevisionId,
      behaviorId: target.behaviorId,
      callKey,
    });

    await authority.assertCurrent();
    durablePin = await getBehaviorCallPin(pinId);
    if (durablePin?.status === 'completed') {
      return {
        success: true,
        data: {
          behaviorId: durablePin.behaviorId,
          behaviorRevisionId: durablePin.behaviorRevisionId,
          flowId: durablePin.flowId,
          contentHash: durablePin.contentHash,
          outputText: durablePin.outputText ?? '',
          recovered: true,
        },
      };
    }
    if (durablePin?.status === 'error') {
      return { success: false, error: durablePin.error ?? 'Behavior Flow execution failed.' };
    }

    if (!durablePin) {
      const { resolveEffectiveBehaviorById } = await import(
        '@/backend/services/enduringAgents/behaviorFlowResolver'
      );
      const { revision } = await resolveEffectiveBehaviorById(
        target.personaId,
        target.behaviorId,
      );
      await authority.assertCurrent();
      durablePin = await authority.commitWhileCurrent(() => createBehaviorCallPin({
        personaId: target.personaId,
        activityId: attribution.activityId!,
        parentBehaviorRevisionId: attribution.behaviorRevisionId!,
        revision,
        callKey,
      }));
    }
    await authority.assertCurrent();

    const { runFlow } = await import('../runFlow');
    const result = await runFlow({
      flowDefinition: structuredClone(durablePin.flowSnapshot),
      prompt: task,
      mode: 'ephemeral',
      source: 'subflow',
      parentRunId: sharedState.logicalRunId ?? sharedState.conversationId,
      depth: (sharedState.runDepth ?? 0) + 1,
      chainDepth: sharedState.chainDepth,
      emit: ctx.emit,
      executionAuthority: authority,
      personaAttribution: {
        ...attribution,
        behaviorRevisionId: durablePin.behaviorRevisionId,
      },
    });

    await authority.assertCurrent();
    if (result.error || result.status === 'error') {
      const message = result.error?.message ?? 'Behavior Flow execution failed.';
      await authority.commitWhileCurrent(() => (
        completeBehaviorCallPin(durablePin!, 'error', message)
      ));
      return { success: false, error: message };
    }
    await authority.commitWhileCurrent(() => (
      completeBehaviorCallPin(durablePin!, 'completed', undefined, result.outputText)
    ));
    return {
      success: true,
      data: {
        behaviorId: durablePin.behaviorId,
        behaviorRevisionId: durablePin.behaviorRevisionId,
        flowId: durablePin.flowId,
        contentHash: durablePin.contentHash,
        outputText: result.outputText,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (durablePin && authority?.commitWhileCurrent) {
      try {
        await authority.commitWhileCurrent(async () => {
          const { completeBehaviorCallPin } = await import(
            '@/backend/services/enduringAgents/behaviorCallPins'
          );
          await completeBehaviorCallPin(durablePin!, 'error', message);
        });
      } catch {
        // A lost fence intentionally prevents a stale holder from mutating the pin.
      }
    }
    log.warn('Persona Behavior tool execution failed', { name, error: message });
    return { success: false, error: message };
  }
}
