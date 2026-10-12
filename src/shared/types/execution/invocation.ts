/**
 * Durable origin of a Flow invocation. Chat and direct API calls are interactive;
 * the other origins run unattended. This contract is shared with origin-display
 * consumers and must not depend on runtime execution state or capabilities.
 */
export const FLOW_INVOCATION_SOURCES = [
  'chat',
  'api',
  'schedule',
  'trigger',
  'subflow',
  'mcp',
  'internal',
  'meeting',
] as const;

export type FlowInvocationSource = typeof FLOW_INVOCATION_SOURCES[number];

export function isFlowInvocationSource(value: unknown): value is FlowInvocationSource {
  return typeof value === 'string' &&
    (FLOW_INVOCATION_SOURCES as readonly string[]).includes(value);
}

export function isUnattendedFlowInvocation(source: FlowInvocationSource): boolean {
  return source !== 'chat' && source !== 'api';
}
