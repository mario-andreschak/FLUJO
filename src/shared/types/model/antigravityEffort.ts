import type { ModelReasoningEffort } from './provider';

/**
 * The levels the official Antigravity CLI accepts for `--effort`, in the order
 * its own help and error text list them. Which levels a model offers comes from
 * `agy models`, never from a FLUJO table.
 */
export const ANTIGRAVITY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ModelReasoningEffort[];
export type AntigravityEffort = typeof ANTIGRAVITY_EFFORT_LEVELS[number];

const EFFORT_VARIANT = new RegExp(`^(.+)-(${ANTIGRAVITY_EFFORT_LEVELS.join('|')})$`);
const LABELLED_NAME = /^(.*\S)\s*\(([^()]+)\)$/;

export function isAntigravityEffort(value: unknown): value is AntigravityEffort {
  return typeof value === 'string' && (ANTIGRAVITY_EFFORT_LEVELS as readonly string[]).includes(value);
}

/** `gemini-3.1-pro-high` is the high level of `gemini-3.1-pro`. */
export function antigravityEffortVariant(id: string): { base: string; effort: AntigravityEffort } | undefined {
  const match = EFFORT_VARIANT.exec(id);
  return match && isAntigravityEffort(match[2]) ? { base: match[1], effort: match[2] } : undefined;
}

/**
 * The CLI refuses `--effort` with its `default` choice and with a name that
 * already carries a level (`gemini-3.1-pro-high`), so neither takes one.
 */
export function antigravityModelTakesEffort(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== '' && trimmed !== 'default' && !antigravityEffortVariant(trimmed);
}

export interface AntigravityListedModel {
  id: string;
  name: string;
  reasoningEfforts?: AntigravityEffort[];
}

/**
 * `agy models` lists one entry per effort level ("gemini-3.1-pro-high", "Gemini
 * 3.1 Pro (High)"). Fold them into one model per base name with the levels
 * listed for it: the CLI resolves `--model <base> --effort <level>` to exactly
 * those entries and refuses any other level. Entries whose labels disagree stay
 * as they are.
 */
export function groupAntigravityEfforts(models: readonly { id: string; name: string }[]): AntigravityListedModel[] {
  const variants = new Map<string, { label: string; efforts: Set<AntigravityEffort>; consistent: boolean }>();
  for (const model of models) {
    const variant = antigravityEffortVariant(model.id);
    const label = LABELLED_NAME.exec(model.name)?.[1];
    if (!variant || !label) continue;
    const group = variants.get(variant.base);
    if (!group) variants.set(variant.base, { label, efforts: new Set([variant.effort]), consistent: true });
    else {
      group.efforts.add(variant.effort);
      group.consistent &&= group.label === label;
    }
  }
  const levels = (base: string): AntigravityEffort[] | undefined => {
    const group = variants.get(base);
    return group?.consistent ? ANTIGRAVITY_EFFORT_LEVELS.filter(level => group.efforts.has(level)) : undefined;
  };
  const grouped = new Map<string, AntigravityListedModel>();
  for (const model of models) {
    const variant = antigravityEffortVariant(model.id);
    const variantLevels = variant && levels(variant.base);
    if (variant && variantLevels) {
      if (!grouped.has(variant.base)) grouped.set(variant.base, { id: variant.base, name: variants.get(variant.base)!.label, reasoningEfforts: variantLevels });
      continue;
    }
    // A plain entry that is also a base name keeps its own label and gains the levels.
    const baseLevels = levels(model.id);
    grouped.set(model.id, { id: model.id, name: model.name, ...(baseLevels ? { reasoningEfforts: baseLevels } : {}) });
  }
  return [...grouped.values()];
}
