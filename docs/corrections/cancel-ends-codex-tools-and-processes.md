# Cancelling a Codex run ends its tool calls, its open tool approvals and every process Codex started

A forced stop ends Codex's whole process tree (its own helpers, such as git,
included). FLUJO's tool bridge tells a tool call when Codex goes away, and a
FLUJO tool waiting for approval stops waiting when the run is cancelled.

Enforced by:
- `__tests__/model/codexStandIn.test.ts`
- `__tests__/model/codexAppServerProcess.test.ts`
