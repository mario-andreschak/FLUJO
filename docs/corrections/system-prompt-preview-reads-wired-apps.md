# The system prompt preview reads the apps wired to a step, like the run does

A saved agent wires its apps to a step with edges; only a run copies them onto the step. The preview
read only the copy, so the built-in FLUJO agent's preview left out the "FLUJO tools" and "Stored
results" parts that the run sends (#1231).

Enforced by:
- `estimateFlujoSystemPromptContext` in `src/shared/utils/flujoSystemPrompt.ts`
- `__tests__/flow/flujoSystemPrompt.test.ts`

Verified by:
- `npm run journey:feature-steps` (the "System prompt parts" step file)
