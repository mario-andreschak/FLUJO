/**
 * Prompt-authoring reference layer — the superset of inline references the
 * PromptBuilder renders as pills.
 *
 * This deliberately sits ONE LEVEL ABOVE `mcpBinding.ts`:
 *
 *   - `mcpBinding` (findBindings / PILL_SCAN) is the COMPILER-facing codec. It
 *     matches ONLY `${tool:...}` / `${resource:...}` / legacy pills. The flow
 *     compiler (`stripPills`) and validation depend on that exact set, and
 *     `${res:NAME}` / `${var:NAME}` / `${global:NAME}` are intentionally
 *     INVISIBLE to it so they
 *     survive compilation and reach the backend resolvers verbatim.
 *
 *   - THIS module is the RENDERING-facing scanner. It additionally recognizes
 *     `${res:NAME}` (a run-scoped resource reference — "Temporary Data") and
 *     `${global:NAME}` so prompt-authoring surfaces can show both as pills,
 *     WITHOUT changing what the compiler sees. `${res:...}` is still resolved at run time by
 *     `resolveRunResourceRefs` — this only affects how it looks while editing.
 *
 * Keep this dependency-light (it runs in the browser). `${res:NAME}` uses the
 * same grammar as the backend `RES_REF_SCAN` (NAME is everything up to the
 * first `}`); the regex is duplicated here rather than imported to avoid a
 * frontend→backend import.
 */

import {
  BindingKind,
  ParsedBinding,
  encodeBindingPill,
  parsePill,
  findBindings,
  bindingLabel,
} from './mcpBinding';

/** Rendering-only, server-less kinds on top of the MCP binding kinds. */
export type PromptRefKind = BindingKind | 'runres' | 'global';

export interface PromptRef {
  kind: PromptRefKind;
  /** MCP server for tool/resource kinds; empty string for rendering-only kinds. */
  server: string;
  /** Tool name / resource URI (MCP kinds), run-resource NAME, or global key. */
  name: string;
}

export interface PromptRefMatch extends PromptRef {
  /** The full matched reference including the `${` … `}` delimiters. */
  fullMatch: string;
  /** Offset of the match within the scanned text. */
  index: number;
}

/** A context-scoped option shown by prompt-authoring `@` pickers. */
export interface PromptReferenceSuggestion extends PromptRef {
  /** Short human-facing name used for filtering and selection. */
  label: string;
  /** Canonical serialized reference inserted into the persisted string. */
  value: string;
  /** Optional context shown under the label (description, URI, or server). */
  description?: string;
}

/** Matches `${res:NAME}`. Mirrors the backend `RES_REF_SCAN` (no `}` inside NAME). */
const RES_REF_SCAN = /\$\{res:([^}]+)\}/g;
/** Matches `${global:NAME}` without accepting an empty name or nested closing brace. */
const GLOBAL_REF_SCAN = /\$\{global:([^}]+)\}/g;

/**
 * Find every renderable reference in a block of text, in document order: the
 * MCP binding pills (`findBindings`) PLUS rendering-only run-resource and global references.
 */
export function findPromptRefs(text: string): PromptRefMatch[] {
  const out: PromptRefMatch[] = findBindings(text).map((b) => ({
    kind: b.kind as PromptRefKind,
    server: b.server,
    name: b.name,
    fullMatch: b.fullMatch,
    index: b.index,
  }));

  RES_REF_SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RES_REF_SCAN.exec(text)) !== null) {
    out.push({
      kind: 'runres',
      server: '',
      // Preserve the raw captured name (no trim) so serialize() round-trips exactly.
      name: m[1],
      fullMatch: m[0],
      index: m.index,
    });
  }

  GLOBAL_REF_SCAN.lastIndex = 0;
  while ((m = GLOBAL_REF_SCAN.exec(text)) !== null) {
    out.push({
      kind: 'global',
      server: '',
      // Preserve the raw key so an untouched expression round-trips exactly.
      name: m[1],
      fullMatch: m[0],
      index: m.index,
    });
  }

  return out.sort((a, b) => a.index - b.index);
}

/** Parse a complete rendering reference string (`${…}`). Null if not one. */
export function parsePromptRefPill(full: string): PromptRef | null {
  if (full.startsWith('${res:') && full.endsWith('}')) {
    const name = full.slice('${res:'.length, -1);
    return name ? { kind: 'runres', server: '', name } : null;
  }
  if (full.startsWith('${global:') && full.endsWith('}')) {
    const name = full.slice('${global:'.length, -1);
    return name ? { kind: 'global', server: '', name } : null;
  }
  const b: ParsedBinding | null = parsePill(full);
  return b ? { kind: b.kind, server: b.server, name: b.name } : null;
}

/** Build the reference text (including `${` … `}`) to embed in a prompt template. */
export function encodePromptRefPill(kind: PromptRefKind, server: string, name: string): string {
  if (kind === 'runres') return `\${res:${name}}`;
  if (kind === 'global') return `\${global:${name}}`;
  return encodeBindingPill(kind, server, name);
}

/** Build a typed picker option while keeping serialization in one codec. */
export function createPromptReferenceSuggestion(
  ref: PromptRef,
  label = ref.name,
  description?: string,
): PromptReferenceSuggestion {
  return {
    ...ref,
    label,
    value: encodePromptRefPill(ref.kind, ref.server, ref.name),
    description,
  };
}

/** Readable chip label for a parsed reference (no `${` … `}`), e.g. `res:NAME`. */
export function promptRefLabel(ref: PromptRef): string {
  if (ref.kind === 'runres') return `res:${ref.name}`;
  if (ref.kind === 'global') return `global:${ref.name}`;
  return bindingLabel({ kind: ref.kind, server: ref.server, name: ref.name });
}

/**
 * The distinct, trimmed NAMEs referenced by `${res:NAME}` across the given
 * texts (e.g. every node's prompt template in a flow), sorted alphabetically.
 * Used to auto-suggest Temporary Data names already in use in the flow.
 */
export function extractResourceRefNames(texts: Array<string | undefined | null>): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue;
    RES_REF_SCAN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RES_REF_SCAN.exec(text)) !== null) {
      const name = m[1].trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
