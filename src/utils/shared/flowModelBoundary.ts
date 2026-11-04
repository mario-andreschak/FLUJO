/**
 * A flow can name the only models it may talk to (`Flow.allowedModels`).
 *
 * A caller that points at FLUJO cannot see which model answers behind it. This list
 * gives such a caller something it can rely on, because the engine checks it before
 * every model turn rather than only when a flow is saved. `undefined` means no
 * restriction. An empty list means no model at all.
 */

export const MODEL_NOT_ALLOWED_CODE = 'model_not_allowed';

/**
 * The models a step sends data to by itself. A Process step has its bound model, and a
 * Static step can hold model decisions. Keep every list of a flow's models on this, so
 * an allowed list cannot miss a step.
 */
export function stepModelIds(type: string | undefined, properties: Record<string, unknown> | undefined): string[] {
  if (type === 'process') {
    return typeof properties?.boundModel === 'string' && properties.boundModel ? [properties.boundModel] : [];
  }
  if (type === 'static' && Array.isArray(properties?.entries)) {
    return (properties.entries as Array<{ kind?: unknown; boundModel?: unknown }>).flatMap((entry) => (
      entry?.kind === 'modelDecision' && typeof entry.boundModel === 'string' && entry.boundModel ? [entry.boundModel] : []
    ));
  }
  return [];
}

/** Both lists must allow a model, because a subflow may not widen what its parent allows. */
export function intersectAllowedModels(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] | undefined {
  if (!first) return second ? [...second] : undefined;
  if (!second) return [...first];
  return first.filter((id) => second.includes(id));
}

/**
 * The model ids a binding would send data to that the list does not allow. A fallback
 * policy sends data to its members, not to itself, so each member must be on the list
 * and the policy's own id does not need to be.
 */
export function modelsOutsideBoundary(
  model: { id: string; fallbackPolicy?: { modelIds: string[] } },
  allowed: readonly string[] | undefined,
): string[] {
  if (!allowed) return [];
  const reached = model.fallbackPolicy?.modelIds ?? [model.id];
  return reached.filter((id) => !allowed.includes(id));
}
