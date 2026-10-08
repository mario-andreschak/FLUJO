import { z } from 'zod';

import type { FlowExecutionAuthority, ToolDefinition } from '../types';
import {
  PERSONA_NATIVE_ABILITY_IDS,
  type PersonaAttribution,
  type PersonaNativeAbilityId,
} from '@/shared/types/enduringAgent';
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
  work_item_list: {
    name: 'work_item_list',
    description: 'Read this Persona\'s durable goals and tasks, including progress, next actions, dependencies and blocked work. Use this to continue an existing plan instead of creating duplicate tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: { type: 'array', items: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'completed', 'cancelled'] } },
        parent_goal_id: { type: 'string', description: 'Optionally show only the tasks belonging to this ongoing goal.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0, description: 'Continue from next_offset when a previous list was truncated.' },
      },
    },
  },
  work_item_create: {
    name: 'work_item_create',
    description: 'Create a durable task. During ongoing-goal work it automatically belongs to that goal and runs when ready; outside an ongoing goal it is saved for assignment. List existing tasks first to avoid duplicates. Run todos remain scratch-scoped unless promoted separately.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        dependency_ids: { type: 'array', items: { type: 'string' } },
        next_action: { type: 'string' },
        deadline: { type: 'number' },
        parent_goal_id: { type: 'string', description: 'The owning ongoing goal. Inherited from the current goal Activity when omitted.' },
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
  report_activity_outcome: {
    name: 'report_activity_outcome',
    description: 'Before ending this Activity, persist what was actually achieved and verified, remaining work and the next action. Succeeded means this Activity succeeded; set goal_achieved only when the entire ongoing goal\'s success criteria are met. A plan or draft alone is not evidence of a published result. Reporting does not end the current run.',
    inputSchema: {
      type: 'object',
      properties: {
        resolution: { type: 'string', enum: ['succeeded', 'partial', 'blocked', 'failed', 'unknown'] },
        summary: { type: 'string', maxLength: 2000, description: 'Verified results with concrete evidence such as artifact paths, source URLs or observed tool results; distinguish completed actions from plans.' },
        next_action: { type: 'string', maxLength: 2000, description: 'Required when work is unfinished. State the next executable step or the exact human input needed.' },
        blocker_kind: { type: 'string', enum: ['information', 'approval', 'permission', 'capability', 'dependency', 'external', 'transient', 'policy', 'unknown'] },
        goal_achieved: { type: 'boolean', description: 'True only when the entire ongoing goal is achieved, all necessary tasks are complete and its success criteria have been verified.' },
        retry_after_ms: { type: 'integer', minimum: 0, maximum: 604800000, description: 'Optional wait before the next attempt, for example when a service is temporarily unavailable or an external result needs time.' },
      },
      required: ['resolution', 'summary'],
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
export function buildPersonaTools(
  requested: unknown,
  options: { maintenanceMemoryProposal?: boolean } = {},
): ToolDefinition[] {
  if (!Array.isArray(requested)) return [];
  const names = [...new Set(requested.filter(
    (value): value is PersonaToolName => typeof value === 'string' && isPersonaToolName(value),
  ))];
  return PERSONA_TOOL_NAMES.filter((name) => names.includes(name)).map((name) => {
    const definition = structuredClone(TOOL_DEFINITIONS[name]);
    if (name === 'remember' && options.maintenanceMemoryProposal) {
      const required = Array.isArray(definition.inputSchema.required)
        ? definition.inputSchema.required.filter((value): value is string => typeof value === 'string')
        : [];
      definition.inputSchema.required = [...new Set([...required, 'evidence_ids'])];
      definition.description = 'Submit one evidence-backed candidate memory during post-Activity maintenance. Invalid proposals are rejected without writing and may be corrected and retried.';
    }
    return definition;
  });
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
      case 'work_item_list': {
        const { queryPersonaWorkItems, withPersonaDomainMutation } = await import(
          '@/backend/services/enduringAgents'
        );
        const limit = z.number().int().min(1).max(100).parse(args.limit ?? 50);
        const offset = z.number().int().min(0).max(1_000_000).parse(args.offset ?? 0);
        const records = await withPersonaDomainMutation(trusted.personaId, options, async ({ activity }) => {
          if (activity?.id !== trusted.activityId) throw new Error('Task access crossed Activity ownership.');
          return queryPersonaWorkItems(trusted.personaId, {
            ...(args.statuses !== undefined ? { statuses: args.statuses as never } : {}),
          });
        });
        const parentGoalId = stringArg(args, 'parent_goal_id');
        const matching = parentGoalId ? records.filter((item) => item.parentGoalId === parentGoalId) : records;
        const truncated = matching.length > offset + limit;
        return { success: true, data: {
          items: matching.slice(offset, offset + limit), total: matching.length, truncated,
          ...(truncated ? { next_offset: offset + limit } : {}),
        } };
      }
      case 'report_activity_outcome': {
        const { reportPersonaActivityOutcome } = await import(
          '@/backend/services/enduringAgents/activityOutcomes'
        );
        const outcome = await reportPersonaActivityOutcome(trusted.personaId, trusted.activityId, {
          resolution: args.resolution as never,
          summary: args.summary as string,
          ...(args.next_action !== undefined ? { nextAction: args.next_action as string } : {}),
          ...(args.blocker_kind !== undefined ? { blockerKind: args.blocker_kind as never } : {}),
          ...(args.goal_achieved !== undefined ? { goalAchieved: args.goal_achieved as boolean } : {}),
          ...(args.retry_after_ms !== undefined ? { retryAfterMs: args.retry_after_ms as number } : {}),
        }, options);
        return { success: true, data: { reported: true, outcome } };
      }
      case 'work_item_create': {
        const { createPersonaWorkItem } = await import(
          '@/backend/services/enduringAgents'
        );
        const item = await createPersonaWorkItem({
          personaId: trusted.personaId,
          title: stringArg(args, 'title') ?? '',
          ...(stringArg(args, 'description') ? { description: stringArg(args, 'description') } : {}),
          ...(stringArg(args, 'priority') ? { priority: args.priority as never } : {}),
          ...(Array.isArray(args.dependency_ids) ? { dependencyIds: args.dependency_ids as string[] } : {}),
          ...(stringArg(args, 'next_action') ? { nextAction: stringArg(args, 'next_action') } : {}),
          ...(typeof args.deadline === 'number' ? { deadline: args.deadline } : {}),
          ...(stringArg(args, 'parent_goal_id') ? { parentGoalId: stringArg(args, 'parent_goal_id') } : {}),
          sourceRefs: activitySource,
        }, options);
        return { success: true, data: { created: true, item } };
      }
      case 'work_item_update': {
        const { updatePersonaWorkItem } = await import(
          '@/backend/services/enduringAgents'
        );
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
        const { updatePersonaWorkItem } = await import(
          '@/backend/services/enduringAgents'
        );
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
        const { promoteRunTodoToWorkItem } = await import(
          '@/backend/services/enduringAgents'
        );
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
        const { suggestBehaviorInstructionImprovement } = await import(
          '@/backend/services/enduringAgents'
        );
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
