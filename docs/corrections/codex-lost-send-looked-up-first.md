# An input Codex may have received before its connection was lost is looked up by its client id on a new connection before anything is sent again; only an input Codex confirms it lacks is sent once more

Every `turn/start` and `turn/steer` carries a fresh `clientUserMessageId`.
After a drop the thread resumes and reads `thread/turns/list`: a finished turn
is shown, an interrupted one is continued without its input, and anything
that cannot be confirmed ends the turn with nothing resent.

Enforced by:
- `__tests__/model/codexAppServerRecovery.test.ts`
- `__tests__/model/codexAppServerProtocolReplay.test.ts`
- `CODEX_CONTINUE_AFTER_DROP` in `src/backend/services/model/adapters/codexAppServerThread.ts`
