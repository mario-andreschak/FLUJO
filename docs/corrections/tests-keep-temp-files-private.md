# Tests keep temp files in a folder FLUJO's privacy check accepts, never by weakening the check

On PCs where `%TEMP%` and `%LOCALAPPDATA%` let other accounts change files, about
21 MCP test files failed with "not private to this account" although the code
was right. Each Jest run now gets its own private temp root, made with FLUJO's
own private-folder code, and FLUJO still refuses folders others can change.

Enforced by:
- `__tests__/meta/privateTestTemp.test.ts`
- `createPrivateTestTemp` in `scripts/private-test-temp.cjs`
