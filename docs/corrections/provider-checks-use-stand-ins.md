# A check that would need a real Claude subscription, Anthropic API key or Codex login runs the real SDK and the real bundled CLI against a local stand-in instead, and is never left to a person

Issues #756, #1092, #1096 and #1351 each ended with "Mario: check this with a
real token". The checks below do it with the shared stand-in of Anthropic's
service (`scripts/anthropic-stand-in.mjs`, documented formats: messages,
prompt-cache usage, subscription rate-limit headers, the usage page, errors and
the 2026-10-21 request rules) and the Codex stand-in. Add a case there instead
of asking for a login.

Enforced by:
- `scripts/anthropic-stand-in.test.mjs`
- `__tests__/model/claudeCodeStandIn.test.ts`
- `__tests__/chat/claudeFlowStandIn.test.ts`
- `__tests__/model/anthropicTestModelStandIn.test.ts`
- `__tests__/model/codexStandIn.test.ts`
- `assertClaudeCodePlatformJob` in `scripts/workflow-contract.mjs`
