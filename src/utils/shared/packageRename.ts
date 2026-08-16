/**
 * Pure bulk-rename helpers for the package installer (issue #407).
 *
 * The install wizard lets a user mass-rename the DISPLAY NAMES of packaged
 * flows and planned executions (triggers) before installing — either by
 * prefixing/suffixing them or by a regex find/replace. This module holds the
 * deterministic, dependency-free logic so BOTH the wizard preview and the
 * backend validation apply exactly the same rules (the client preview and the
 * server result can never disagree).
 *
 * Scope is deliberately display names ONLY. Deterministic entity ids, webhook
 * identifiers/tokens, flow-event topics and internal references are derived
 * from the ORIGINAL manifest values and are never touched here — renaming must
 * not break idempotent reinstall / uninstall (see installPackage.ts).
 */

/** How the bulk rename derives a new display name. */
export type RenameMode = 'none' | 'prefix' | 'suffix' | 'regex';

export interface RenameRule {
  mode: RenameMode;
  /** `prefix` mode: text prepended to every name. */
  prefix?: string;
  /** `suffix` mode: text appended to every name. */
  suffix?: string;
  /** `regex` mode: the (JavaScript) search pattern. */
  pattern?: string;
  /** `regex` mode: the replacement (supports `$1` capture references). */
  replacement?: string;
  /** `regex` mode: case-insensitive matching. */
  caseInsensitive?: boolean;
  /** `regex` mode: replace every occurrence (default) instead of the first. */
  replaceAll?: boolean;
}

/** Longest accepted display name — mirrored by the REST route's body limits. */
export const MAX_RENAME_LENGTH = 200;

/** Upper bound on how many renames one install request may carry. */
export const MAX_RENAME_ENTRIES = 500;

/** A renameable entity: a stable key plus its manifest display name. */
export interface RenameCandidate {
  /** Stable identity used as the rename-map key (flow local id / execution name). */
  key: string;
  /** The display name as authored in the package manifest. */
  original: string;
  /** Optional grouping label, purely for the UI. */
  kind?: 'flow' | 'plannedExecution';
}

export interface RenamePreviewItem {
  key: string;
  original: string;
  /** The resulting display name (equal to `original` when nothing changed). */
  renamed: string;
  changed: boolean;
  /** Item-level problem (blank result, too long, duplicate, host collision). */
  error?: string;
}

export interface RenamePreview {
  items: RenamePreviewItem[];
  /** key -> new display name, only for entries that actually changed. */
  map: Record<string, string>;
  /** Rule-level problem (e.g. a malformed regular expression). */
  ruleError?: string;
  /** Every item-level error, in item order. */
  errors: string[];
  /** True when the rule compiled and no item has an error. */
  valid: boolean;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a rule into a pure `(name) => name` function. Returns an `error`
 * instead of throwing when the regex is malformed, so callers can render the
 * message next to the pattern field.
 */
export function compileRenameRule(rule: RenameRule): {
  apply?: (name: string) => string;
  error?: string;
} {
  switch (rule.mode) {
    case 'none':
      return { apply: (name) => name };
    case 'prefix': {
      const prefix = rule.prefix ?? '';
      return { apply: (name) => `${prefix}${name}` };
    }
    case 'suffix': {
      const suffix = rule.suffix ?? '';
      return { apply: (name) => `${name}${suffix}` };
    }
    case 'regex': {
      const pattern = rule.pattern ?? '';
      if (pattern === '') return { apply: (name) => name };
      let re: RegExp;
      try {
        const flags = `${rule.replaceAll === false ? '' : 'g'}${rule.caseInsensitive ? 'i' : ''}`;
        re = new RegExp(pattern, flags);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
      const replacement = rule.replacement ?? '';
      return {
        apply: (name) => {
          // A fresh RegExp per call keeps `lastIndex` from leaking between names.
          const local = new RegExp(re.source, re.flags);
          return name.replace(local, replacement);
        },
      };
    }
    default:
      return { error: `Unsupported rename mode: ${String((rule as RenameRule).mode)}` };
  }
}

/** Trim + collapse nothing: names are compared case-insensitively for collisions. */
function collisionKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Apply `rule` to every candidate and report the resulting names together with
 * every blocking problem. `existingNames` are host entities of the SAME kind
 * that the install would collide with (excluding the ones this package already
 * owns) — they are reported as item-level errors.
 */
export function buildRenamePreview(
  candidates: RenameCandidate[],
  rule: RenameRule,
  options: { existingNames?: string[] } = {},
): RenamePreview {
  const compiled = compileRenameRule(rule);
  if (!compiled.apply) {
    return {
      items: candidates.map((c) => ({ key: c.key, original: c.original, renamed: c.original, changed: false })),
      map: {},
      ruleError: compiled.error ?? 'Invalid rename rule',
      errors: [],
      valid: false,
    };
  }

  const taken = new Set((options.existingNames ?? []).map(collisionKey));
  const seen = new Map<string, string>(); // collisionKey -> first original name
  const items: RenamePreviewItem[] = [];
  const map: Record<string, string> = {};

  for (const candidate of candidates) {
    let renamed = candidate.original;
    try {
      renamed = compiled.apply(candidate.original);
    } catch (err) {
      items.push({
        key: candidate.key,
        original: candidate.original,
        renamed: candidate.original,
        changed: false,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const item: RenamePreviewItem = {
      key: candidate.key,
      original: candidate.original,
      renamed,
      changed: renamed !== candidate.original,
    };

    const key = collisionKey(renamed);
    if (renamed.trim() === '') {
      item.error = 'Name cannot be empty';
    } else if (renamed.length > MAX_RENAME_LENGTH) {
      item.error = `Name must be ${MAX_RENAME_LENGTH} characters or fewer`;
    } else if (seen.has(key)) {
      item.error = `Duplicate name — "${seen.get(key)}" produces the same result`;
    } else if (taken.has(key)) {
      item.error = 'Name already used by an existing item on this host';
    }

    if (!item.error) seen.set(key, candidate.original);
    if (!item.error && item.changed) map[candidate.key] = renamed;
    items.push(item);
  }

  const errors = items.map((i) => i.error).filter((e): e is string => typeof e === 'string');
  return { items, map, errors, valid: errors.length === 0 };
}

/**
 * Re-validate an explicit rename map (the shape sent over the wire). Returns a
 * list of human-readable errors; an empty list means the map is safe to apply.
 * The backend runs this again so a hand-crafted request cannot bypass the
 * wizard's checks.
 */
export function validateRenameMap(
  map: Record<string, string>,
  candidates: RenameCandidate[],
  options: { existingNames?: string[]; label?: string } = {},
): string[] {
  const label = options.label ?? 'rename';
  const errors: string[] = [];
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const entries = Object.entries(map);

  if (entries.length > MAX_RENAME_ENTRIES) {
    errors.push(`Too many ${label} entries (max ${MAX_RENAME_ENTRIES})`);
    return errors;
  }

  for (const [key, value] of entries) {
    if (!byKey.has(key)) {
      errors.push(`Unknown ${label} target "${key}"`);
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`Invalid ${label} for "${key}": name cannot be empty`);
    } else if (value.length > MAX_RENAME_LENGTH) {
      errors.push(`Invalid ${label} for "${key}": name must be ${MAX_RENAME_LENGTH} characters or fewer`);
    }
  }

  // Collisions are evaluated over the EFFECTIVE names (renamed + untouched).
  const taken = new Set((options.existingNames ?? []).map(collisionKey));
  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    const effective = typeof map[candidate.key] === 'string' ? map[candidate.key] : candidate.original;
    if (typeof effective !== 'string' || effective.trim() === '') continue;
    const key = collisionKey(effective);
    if (seen.has(key)) {
      errors.push(`Duplicate ${label} result "${effective}" (from "${seen.get(key)}" and "${candidate.original}")`);
      continue;
    }
    seen.set(key, candidate.original);
    // Only a RENAMED entity can collide with the host: untouched names keep
    // whatever adoption/idempotency behaviour the installer already had.
    if (map[candidate.key] !== undefined && taken.has(key)) {
      errors.push(`Invalid ${label} for "${candidate.original}": "${effective}" already exists on this host`);
    }
  }

  return errors;
}

/** Effective display name for a candidate under a rename map. */
export function effectiveName(map: Record<string, string> | undefined, key: string, original: string): string {
  const renamed = map?.[key];
  return typeof renamed === 'string' && renamed.trim() !== '' ? renamed : original;
}
