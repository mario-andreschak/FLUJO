import { z } from 'zod';

import type { FlowExecutionAuthority, ToolDefinition } from '../types';
import {
  PERSONA_NATIVE_ABILITY_IDS,
  type PersonaAttribution,
  type PersonaNativeAbilityId,
} from '@/shared/types/enduringAgent';
import {
  createPersonaWorkItem,
  promoteRunTodoToWorkItem,
  suggestBehaviorInstructionImprovement,
  updatePersonaWorkItem,
} from '@/backend/services/enduringAgents';
import {
  PERSONA_MEMORY_TOOL_DEFINITIONS,
  executePersonaMemoryGatewayTool,
  isPersonaMemoryToolName,
  requirePersonaGatewayContext,
} from './personaMemoryGateway';

export const PERSONA_TOOL_NAMES = PERSONA_NATIVE_ABILITY_IDS;
export type PersonaToolName = PersonaNativeAbilityId;

const PersonaToolNameSchema = z.enum(PERSONA_TOOL_NAMES);

const TOOL_DEFINITIONS: Record<PersonaToolName, ToolDefinition> = {
  ...PERSONA_MEMORY_TOOL_DEFINITIONS,
  work_item_create: {
    name: 'work_item_create',
    description: 'Create an explicit durable Persona commitment. Run todos remain scratch-scoped unless promoted separately.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        dependency_ids: { type: 'array', items: { type: 'string' } },
        next_action: { type: 'string' },
        deadline: { type: 'number' },
      },
      required: ['title'],
    },
  },
  work_item_update: {
    name: 'work_item_update',
    description: 'Update a durable Persona WorkItem, including status, priority, dependencies, deadline, and next action.',
    inputSchema: {
      type: 'object',
      properties: {
        work_item_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'completed', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        dependency_ids: { type: 'array', items: { type: 'string' } },
        next_action: { type: ['string', 'null'] },
        deadline: { type: ['number', 'null'] },
        expected_updated_at: { type: 'number' },
      },
      required: ['work_item_id'],
    },
  },
  work_item_complete: {
    name: 'work_item_complete',
    description: 'Complete one durable Persona WorkItem after all dependencies are completed.',
    inputSchema: {
      type: 'object',
      properties: {
        work_item_id: { type: 'string' },
        expected_updated_at: { type: 'number' },
      },
      required: ['work_item_id'],
    },
  },
  work_item_promote_todo: {
    name: 'work_item_promote_todo',
    description: 'Explicitly promote one pending/in-progress run todo into a durable Persona WorkItem. The scratch todo is not changed.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        next_action: { type: 'string' },
        deadline: { type: 'number' },
      },
      required: ['todo_id'],
    },
  },
  suggest_improvement: {
    name: 'suggest_improvement',
    description: 'After completing work, propose one reusable instruction-only Behavior improvement when concrete Activity evidence shows it would help future work. The change is validated, shown in Improvements, and follows the user-selected review rule.',
    inputSchema: {
      type: 'object',
      properties: {
        behavior_slot: {
          type: 'string',
          description: 'Behavior slot to improve. Use primary for the main Persona Flow.',
        },
        rationale: {
          type: 'string',
          description: 'Plain-language explanation of the repeated problem and expected benefit.',
        },
        instruction: {
          type: 'string',
          description: 'One concise reusable instruction for future work. Do not include credentials, external content, or task-specific facts.',
        },
      },
      required: ['rationale', 'instruction'],
    },
  },
};

export function isPersonaToolName(value: string): value is PersonaToolName {
  return PersonaToolNameSchema.safeParse(value).success;
}
export function buildPersonaTools(requested: unknown): ToolDefinition[] {
  if (!Array.isArray(requested)) return [];
  const names = [...new Set(requested.filter(
    (value): value is PersonaToolName => typeof value === 'string' && isPersonaToolName(value),
  ))];
  return PERSONA_TOOL_NAMES.filter((name) => names.includes(name)).map(
    (name) => structuredClone(TOOL_DEFINITIONS[name]),
  );
}

export interface PersonaToolContext {
  personaAttribution?: PersonaAttribution;
  executionAuthority?: FlowExecutionAuthority;
  conversationId?: string;
}

export interface PersonaToolOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

function requireContext(ctx: PersonaToolContext): {
  personaId: string;
  activityId: string;
  behaviorRevisionId: string;
  executionAuthority: FlowExecutionAuthority;
} {
  return requirePersonaGatewayContext(ctx);
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key].trim() || undefined : undefined;
}

export async function executePersonaTool(
  toolName: PersonaToolName,
  args: Record<string, unknown>,
  ctx: PersonaToolContext,
): Promise<PersonaToolOutcome> {
  if (isPersonaMemoryToolName(toolName)) {
    return executePersonaMemoryGatewayTool(toolName, args, ctx);
  }
  try {
    const trusted = requireContext(ctx);
    const options = { executionAuthority: trusted.executionAuthority };
    const activitySource = [{
      kind: 'activity' as const,
      id: trusted.activityId,
      ...(ctx.conversationId ? { uri: `flujo://conversation/${ctx.conversationId}` } : {}),
    }];
    switch (toolName) {
      case 'work_item_create': {
        const item = await createPersonaWorkItem({
          personaId: trusted.personaId,
          title: stringArg(args, 'title') ?? '',
          ...(stringArg(args, 'description') ? { description: stringArg(args, 'description') } : {}),
          ...(stringArg(args, 'priority') ? { priority: args.priority as never } : {}),
          ...(Array.isArray(args.dependency_ids) ? { dependencyIds: args.dependency_ids as string[] } : {}),
          ...(stringArg(args, 'next_action') ? { nextAction: stringArg(args, 'next_action') } : {}),
          ...(typeof args.deadline === 'number' ? { deadline: args.deadline } : {}),
          sourceRefs: activitySource,
        }, options);
        return { success: true, data: { created: true, item } };
      }
      case 'work_item_update': {
        const item = await updatePersonaWorkItem(
          trusted.personaId,
          stringArg(args, 'work_item_id') ?? '',
          {
            ...(stringArg(args, 'title') ? { title: stringArg(args, 'title') } : {}),
            ...(args.description === null || typeof args.description === 'string'
              ? { description: args.description as string | null }
              : {}),
            ...(stringArg(args, 'status') ? { status: args.status as never } : {}),
            ...(stringArg(args, 'priority') ? { priority: args.priority as never } : {}),
            ...(Array.isArray(args.dependency_ids) ? { dependencyIds: args.dependency_ids as string[] } : {}),
            ...(args.next_action === null || typeof args.next_action === 'string'
              ? { nextAction: args.next_action as string | null }
              : {}),
            ...(args.deadline === null || typeof args.deadline === 'number'
              ? { deadline: args.deadline as number | null }
              : {}),
            ...(typeof args.expected_updated_at === 'number'
              ? { expectedUpdatedAt: args.expected_updated_at }
              : {}),
          },
          options,
        );
        return { success: true, data: { updated: true, item } };
      }
      case 'work_item_complete': {
        const item = await updatePersonaWorkItem(
          trusted.personaId,
          stringArg(args, 'work_item_id') ?? '',
          {
            status: 'completed',
            ...(typeof args.expected_updated_at === 'number'
              ? { expectedUpdatedAt: args.expected_updated_at }
              : {}),
          },
          options,
        );
        return { success: true, data: { completed: true, item } };
      }
      case 'work_item_promote_todo': {
        const item = await promoteRunTodoToWorkItem(trusted.personaId, {
          todoId: stringArg(args, 'todo_id') ?? '',
          ...(stringArg(args, 'title') ? { title: stringArg(args, 'title') } : {}),
          ...(stringArg(args, 'priority') ? { priority: args.priority as never } : {}),
          ...(stringArg(args, 'next_action') ? { nextAction: stringArg(args, 'next_action') } : {}),
          ...(typeof args.deadline === 'number' ? { deadline: args.deadline } : {}),
        }, options);
        return { success: true, data: { promoted: true, item } };
      }
      case 'suggest_improvement': {
        await trusted.executionAuthority.assertCurrent();
        const proposal = await suggestBehaviorInstructionImprovement({
          personaId: trusted.personaId,
          slotKey: stringArg(args, 'behavior_slot') ?? 'primary',
          rationale: stringArg(args, 'rationale') ?? '',
          instruction: stringArg(args, 'instruction') ?? '',
          evidenceRefs: activitySource,
        });
        await trusted.executionAuthority.assertCurrent();
        return {
          success: true,
          data: {
            proposed: true,
            applied: proposal.status === 'activated',
            proposal,
          },
        };
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Persona tool failed.',
    };
  }
}
