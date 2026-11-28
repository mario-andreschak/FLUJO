# The Codex a shipped FLUJO runs is checked where it is installed: a conversation, a restart and a cancel against the local model stand-in

The Windows installer's fresh install runs `scripts/packaged-codex-acceptance.mjs`
on its own Codex; release safety runs the same checks on Windows and Linux.

Enforced by:
- `assertPackagedCodexAcceptance` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`
- `scripts/packaged-codex-acceptance.test.mjs`
