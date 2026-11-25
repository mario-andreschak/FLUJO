# A resumed Claude session gets each turn's per-turn instructions exactly once and keeps its conversation; changed stable instructions start a new session; a resumed turn leaves parked Claude processes alone. Re-check on every Agent SDK upgrade

Enforced by:
- `__tests__/model/claudeSessionPromptResume.test.ts` (installed SDK with its bundled Claude Code and a stand-in model service on this machine)
