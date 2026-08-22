import type { AskFlujoUiAction } from '@/frontend/types/askFlujo';

const TAGGED_ACTIONS_RE = /<flujo-ui-actions>\s*([\s\S]*?)\s*<\/flujo-ui-actions>/gi;
const FENCED_ACTIONS_RE = /```flujo-ui-actions\s*([\s\S]*?)\s*```/gi;
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export interface ParsedAskFlujoResponse {
  text: string;
  actions: AskFlujoUiAction[];
}

function parseActionPayload(raw: string): AskFlujoUiAction[] {
  try {
    const parsed = JSON.parse(raw) as { actions?: unknown } | unknown[];
    const candidates = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { actions?: unknown })?.actions)
        ? (parsed as { actions: unknown[] }).actions
        : [];

    return candidates.slice(0, 20).flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const action = candidate as Record<string, unknown>;
      if (action.type !== 'highlight' && action.type !== 'set_value') return [];
      if (action.type === 'set_value' && !('value' in action)) return [];
      if (!action.target || typeof action.target !== 'object') return [];
      const target = action.target as Record<string, unknown>;
      if (typeof target.kind !== 'string' || !target.kind.trim()) return [];
      return [{
        id: typeof action.id === 'string' && action.id ? action.id : `ui-action-${index + 1}`,
        type: action.type,
        target: {
          kind: target.kind,
          ...(typeof target.id === 'string' ? { id: target.id } : {}),
          ...(typeof target.field === 'string' ? { field: target.field } : {}),
          ...(typeof target.path === 'string' ? { path: target.path } : {}),
        },
        ...('value' in action ? { value: action.value } : {}),
        ...(typeof action.label === 'string' ? { label: action.label } : {}),
        ...(typeof action.evidence === 'string' ? { evidence: action.evidence } : {}),
      } satisfies AskFlujoUiAction];
    });
  } catch {
    return [];
  }
}

/** Read typed UI proposals from FLUJO MCP tool calls in the canonical transcript. */
export function extractAskFlujoToolActions(messages: unknown[]): AskFlujoUiAction[] {
  const actions: AskFlujoUiAction[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue;
      const record = call as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const name = record.function?.name;
      if (typeof name !== 'string' || !name.endsWith('propose_ui_action')) continue;
      const rawArguments = record.function?.arguments;
      if (typeof rawArguments !== 'string') continue;
      try {
        const parsed = JSON.parse(rawArguments) as Record<string, unknown>;
        const normalized = parseActionPayload(JSON.stringify({ actions: [{
          ...parsed,
          id: typeof record.id === 'string' ? record.id : undefined,
        }] }));
        actions.push(...normalized);
      } catch {
        // A malformed tool call stays visible in the normal transcript but cannot touch the UI.
      }
    }
  }
  return actions;
}

/** Remove the machine-readable action envelope before rendering assistant prose. */
export function parseAskFlujoResponse(raw: string): ParsedAskFlujoResponse {
  const actions: AskFlujoUiAction[] = [];
  const strip = (pattern: RegExp, source: string) => source.replace(pattern, (_match, payload: string) => {
    actions.push(...parseActionPayload(payload));
    return '';
  });
  const withoutTags = strip(TAGGED_ACTIONS_RE, raw);
  const text = strip(FENCED_ACTIONS_RE, withoutTags).trim();
  return { text, actions };
}

export function normalizeAskFlujoPath(path: string | undefined): string[] {
  if (!path) return [];
  const segments = path.startsWith('/')
    ? path.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    : path.split('.');
  return segments.filter(Boolean);
}

/** Immutable, prototype-safe update used by page adapters for reviewable UI edits. */
export function setAskFlujoValueAtPath<T>(source: T, path: string | undefined, value: unknown): T {
  const segments = normalizeAskFlujoPath(path);
  if (segments.length === 0 || segments.length > 20 || segments.some(segment => UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new Error('The requested field path is not editable.');
  }

  if (source === null || typeof source !== 'object') {
    throw new Error('The editable source must be an object or array.');
  }
  type MutableContainer = Record<string, unknown> | unknown[];
  const cloneContainer = (input: object): MutableContainer => (
    Array.isArray(input) ? [...input] : { ...input as Record<string, unknown> }
  );
  const readSegment = (container: object, segment: string): unknown => (
    Array.isArray(container)
      ? container[Number(segment)]
      : (container as Record<string, unknown>)[segment]
  );
  const writeSegment = (container: MutableContainer, segment: string, next: unknown): void => {
    if (Array.isArray(container)) container[Number(segment)] = next;
    else container[segment] = next;
  };

  const root = cloneContainer(source);
  let cursor: MutableContainer = root;
  let sourceCursor: unknown = source;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!sourceCursor || typeof sourceCursor !== 'object') {
      throw new Error(`The field path does not exist at "${segment}".`);
    }
    const current = readSegment(sourceCursor, segment);
    if (current === null || typeof current !== 'object') {
      throw new Error(`The field path does not exist at "${segment}".`);
    }
    const cloned = cloneContainer(current);
    writeSegment(cursor, segment, cloned);
    cursor = cloned;
    sourceCursor = current;
  }
  const last = segments[segments.length - 1];
  if (!sourceCursor || !(last in Object(sourceCursor))) {
    throw new Error(`The field "${last}" does not exist.`);
  }
  writeSegment(cursor, last, value);
  return root as T;
}

/** Apply the shared visual treatment and scroll the requested UI target into view. */
export function highlightAskFlujoElement(element: Element | null, durationMs = 9000): boolean {
  if (!(element instanceof HTMLElement)) return false;
  document.querySelectorAll('.ask-flujo-highlight').forEach(node => node.classList.remove('ask-flujo-highlight'));
  element.classList.add('ask-flujo-highlight');
  element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  window.setTimeout(() => element.classList.remove('ask-flujo-highlight'), durationMs);
  return true;
}
