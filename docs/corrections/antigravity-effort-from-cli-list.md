# Antigravity effort levels come from the CLI's own model list (`agy models`), never from a FLUJO table someone must keep checking

The CLI lists one entry per level ("gemini-3.1-pro-high", "Gemini 3.1 Pro
(High)") and resolves `--model <base> --effort <level>` to exactly those
entries. The real-CLI suite fails when the CLI's refusal names other levels
than FLUJO derived.

Enforced by:
- `__tests__/model/antigravityEffort.test.ts`
- `__tests__/model/antigravityCliIntegration.test.ts`
- `groupAntigravityEfforts` in `src/shared/types/model/antigravityEffort.ts`
