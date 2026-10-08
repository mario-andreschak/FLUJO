import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  PersonaDomainNotFoundError,
  readPersonaComposition,
  updatePersonaComposition,
} from '@/backend/services/enduringAgents';

export const PERSONA_COMPOSITION_TOOL_NAMES = [
  'read_persona_composition',
  'update_persona_composition',
] as const;

export function isPersonaCompositionTool(name: string): boolean {
  return (PERSONA_COMPOSITION_TOOL_NAMES as readonly string[]).includes(name);
}

export function personaCompositionToolDefinitions(): Tool[] {
  return [
    {
      name: 'read_persona_composition',
      description:
        'Read the friendly editable Persona composition: Role, Core Flow, Behaviors, Apps, and Memories. Runtime revisions, hashes, leases, and snapshots are omitted.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          persona_id: { type: 'string', minLength: 1, maxLength: 64 },
        },
        required: ['persona_id'],
      },
    },
    {
      name: 'update_persona_composition',
      description:
        'Atomically update the Persona name, Core Flow, Behaviors, or core Memories after validating them in the active workspace. Apps are changed through Persona App grants. Requires the expected_updated_at concurrency token.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          persona_id: { type: 'string', minLength: 1, maxLength: 64 },
          expected_updated_at: { type: 'number', minimum: 0 },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          core_flow_ref: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
          memory_refs: {
            type: 'array',
            maxItems: 256,
            items: { type: 'string', minLength: 1, maxLength: 64 },
          },
          behaviors: {
            type: 'array',
            maxItems: 64,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', minLength: 1, maxLength: 64 },
                name: { type: 'string', minLength: 1, maxLength: 160 },
                source_flow_ref: { type: 'string', minLength: 1, maxLength: 256 },
                override_flow_ref: {
                  type: ['string', 'null'],
                  minLength: 1,
                  maxLength: 256,
                },
              },
              required: ['ref', 'name', 'source_flow_ref'],
            },
          },
        },
        required: ['persona_id', 'expected_updated_at'],
      },
    },
  ];
}

function text(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function behaviorInputs(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
    const behavior = candidate as Record<string, unknown>;
    return {
      ref: behavior.ref,
      name: behavior.name,
      sourceFlowRef: behavior.source_flow_ref,
      ...(Object.prototype.hasOwnProperty.call(behavior, 'override_flow_ref')
        ? { overrideFlowRef: behavior.override_flow_ref }
        : {}),
    };
  });
}

export async function callPersonaCompositionTool(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const personaId = args.persona_id;
  if (typeof personaId !== 'string') {
    throw new Error('persona_id is required.');
  }

  if (name === 'read_persona_composition') {
    const composition = await readPersonaComposition(personaId);
    if (!composition) throw new PersonaDomainNotFoundError('Persona', personaId);
    return text(composition);
  }

  if (name === 'update_persona_composition') {
    return text(await updatePersonaComposition(personaId, {
      expectedUpdatedAt: args.expected_updated_at,
      ...(Object.prototype.hasOwnProperty.call(args, 'name') ? { name: args.name } : {}),
      ...(Object.prototype.hasOwnProperty.call(args, 'core_flow_ref')
        ? { coreFlowRef: args.core_flow_ref }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(args, 'memory_refs')
        ? { memoryRefs: args.memory_refs }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(args, 'behaviors')
        ? { behaviors: behaviorInputs(args.behaviors) }
        : {}),
    }));
  }

  throw new Error(`Unknown Persona composition tool: ${name}`);
}
