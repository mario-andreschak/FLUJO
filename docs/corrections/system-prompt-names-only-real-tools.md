# FLUJO's own system prompt tells a model only about tools and helpers the step really offers, and each part has a switch that removes it

Enforced by:
- `planFlujoSystemPromptSections` in `src/shared/utils/flujoSystemPrompt.ts`
- `__tests__/flow/flujoSystemPrompt.test.ts`, `__tests__/flow/processNodeSystemSections.test.ts`
