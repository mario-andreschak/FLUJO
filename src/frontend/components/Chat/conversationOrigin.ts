import type { FlowInvocationSource } from '@/backend/execution/flow/types';

export type ConversationOriginKey = FlowInvocationSource | 'unknown';

export interface ConversationOriginInput {
  source?: FlowInvocationSource | null;
  plannedExecutionId?: string | null;
  parentConversationId?: string | null;
}

export interface ConversationOriginMeta {
  key: ConversationOriginKey;
  label: string;
  description: string;
  inferred: boolean;
}

const ORIGIN_META: Record<ConversationOriginKey, Omit<ConversationOriginMeta, 'key' | 'inferred'>> = {
  chat: {
    label: 'User chat',
    description: 'Started interactively from the chat workspace',
  },
  api: {
    label: 'API',
    description: 'Started through the chat completions API',
  },
  schedule: {
    label: 'Automation',
    description: 'Started by a planned execution or automation trigger',
  },
  trigger: {
    label: 'Trigger',
    description: 'Started by an unattended runtime trigger',
  },
  subflow: {
    label: 'Subflow',
    description: 'Spawned by another flow conversation',
  },
  mcp: {
    label: 'MCP run',
    description: "Started through FLUJO's MCP interface",
  },
  internal: {
    label: 'Internal',
    description: 'Started by an internal FLUJO tool',
  },
  unknown: {
    label: 'Unknown origin',
    description: 'Origin metadata was not recorded for this older conversation',
  },
};

function meta(key: ConversationOriginKey, inferred: boolean): ConversationOriginMeta {
  return { key, ...ORIGIN_META[key], inferred };
}

/**
 * Resolve the durable invocation source into user-facing sidebar copy. Older
 * conversations predate source, so infer only from unambiguous lineage fields
 * and otherwise say that the origin is unknown instead of mislabelling it.
 */
export function getConversationOrigin(input: ConversationOriginInput): ConversationOriginMeta {
  if (input.source && input.source in ORIGIN_META) return meta(input.source, false);
  if (input.plannedExecutionId) return meta('schedule', true);
  if (input.parentConversationId) return meta('subflow', true);
  return meta('unknown', true);
}
