/**
 * Run-scoped named variables (Tier 2c — structured state / scratchpad).
 *
 * A flow can save a step's output into a named variable
 * (`captureVariable: "NAME"` on a process/subflow node) and any later step can
 * inject it into its prompt / isolatedPrompt / subflow input with `${var:NAME}`.
 * The variables live on `SharedState.variables` for the life of the run (persisted
 * with the conversation for multi-turn chats; discarded with an ephemeral child
 * run), so a captured value survives `inputMode: 'latest-message'`/`'isolated'`
 * scoping that would otherwise drop it from the visible history.
 *
 * This resolver is the ${var:NAME} → value substitution. It is deliberately:
 *   - PURE and crypto-free: a plain map lookup, unlike `resolveGlobalVars`
 *     (server-only, storage-backed, DECRYPTING) which handles `${global:VAR}` for
 *     MCP args / API keys. Do NOT route model output through resolveGlobalVars —
 *     it would attempt spurious decryption and risk persisting model text under
 *     secret semantics. Run vars are plaintext, never secrets, never masked.
 *   - dependency-light so it runs in the browser (spec validation) and backend
 *     (ProcessNode/SubflowNode) alike, mirroring the shape of edgeConditions.ts.
 *
 * `${var:NAME}` is intentionally invisible to the pill scanner (mcpBinding.ts
 * PILL_SCAN only matches `tool:`/`resource:`/legacy bodies), so vars and tool
 * pills never interfere.
 */

/** The `${var:NAME}` pattern. NAME is everything up to the first `}`. */
export const RUN_VAR_SCAN = /\$\{var:([^}]+)\}/g;

/**
 * Replace every `${var:NAME}` in `text` with `vars[NAME]`. An UNKNOWN name
 * resolves to '' (empty string), NOT the literal `${var:NAME}` — this avoids
 * leaking the raw token to a small model that would then parrot it; pair it with
 * the validation warning (flowValidation) so authors catch ordering/typo bugs.
 * A missing/empty `vars` map leaves the text unchanged only when it contains no
 * references (unknown names still collapse to '').
 *
 * Pure and total: never throws. `NAME` is trimmed so `${var: foo }` matches `foo`.
 */
export function resolveRunVars(text: string, vars: Record<string, string> | undefined | null): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!RUN_VAR_SCAN.test(text)) return text; // fast path: no references at all
  const map = vars ?? {};
  return text.replace(RUN_VAR_SCAN, (_full, rawName: string) => {
    const name = rawName.trim();
    const value = map[name];
    if (typeof value === 'string') return value;
    // Unknown var: substitute empty string (documented) and warn so the author
    // can catch a typo or a step that captures too late.
    console.warn(`[resolveRunVars] unknown variable "${name}"; substituting empty string`);
    return '';
  });
}

/** True when `text` contains at least one `${var:NAME}` reference. */
export function hasRunVarRef(text: string | undefined | null): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  RUN_VAR_SCAN.lastIndex = 0;
  return RUN_VAR_SCAN.test(text);
}

/** The NAMEs referenced by every `${var:NAME}` in `text`, de-duplicated, trimmed. */
export function referencedRunVars(text: string | undefined | null): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const names = new Set<string>();
  RUN_VAR_SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RUN_VAR_SCAN.exec(text)) !== null) {
    const name = m[1].trim();
    if (name) names.add(name);
  }
  return [...names];
}

/** A syntactically valid capture-variable name (sane identifier). Used by
 *  validation to flag names that would be awkward to reference. */
export const RUN_VAR_NAME_RE = /^[A-Za-z_][\w-]*$/;

/** True when `name` is a sane capture-variable identifier. */
export function isValidRunVarName(name: unknown): name is string {
  return typeof name === 'string' && RUN_VAR_NAME_RE.test(name);
}
