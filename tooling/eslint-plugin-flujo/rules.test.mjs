import { describe, it } from 'node:test';
import tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import plugin from './index.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
    globals: { setTimeout: 'readonly', setInterval: 'readonly', requestAnimationFrame: 'readonly', requestIdleCallback: 'readonly', window: 'readonly' },
  },
});
const { rules } = plugin;

tester.run('no-workaround-comment', rules['no-workaround-comment'], {
  valid: [
    '// Keep the newest event first so the list reads top-down.',
    '/* hackathon demo data lives in fixtures */',
    'const workaroundCount = 0;',
  ],
  invalid: [
    { code: "// Let's allow overwrite for now.\nwrite();", errors: [{ messageId: 'workaround' }] },
    { code: '/* quick fix: release later, in case it comes back */', errors: [{ messageId: 'workaround' }] },
    { code: '// HACK around the flicker', errors: [{ messageId: 'workaround' }] },
    { code: '// Work-around for the race', errors: [{ messageId: 'workaround' }] },
  ],
});

tester.run('disable-needs-reason', rules['disable-needs-reason'], {
  valid: [
    '// eslint-disable-next-line no-console -- the CLI prints to stdout\nconsole.log(1);',
    '/* eslint-disable no-console -- generated file */',
    '// an eslint-disable mention inside prose is not a directive',
  ],
  invalid: [
    { code: '// eslint-disable-next-line no-console\nconsole.log(1);', errors: [{ messageId: 'noReason' }] },
    // A bare block-level `eslint-disable` also silences this rule; ESLint applies it to every report after it.
    { code: '// eslint-disable-next-line\nconsole.log(1);', errors: [{ messageId: 'noRule' }] },
    { code: 'run(); // eslint-disable-line no-console --   ', errors: [{ messageId: 'noReason' }] },
  ],
});

tester.run('no-double-cast', rules['no-double-cast'], {
  valid: ['const a = value as Widget;', 'const b = value as unknown;', 'const c = <Widget>value;'],
  invalid: [
    { code: 'const a = value as unknown as Widget;', errors: [{ messageId: 'doubleCast' }] },
    { code: 'const b = <Widget><unknown>value;', errors: [{ messageId: 'doubleCast' }] },
  ],
});

tester.run('no-node-vm', rules['no-node-vm'], {
  valid: [
    "import { runToolScript } from '@/backend/execution/flow/codeMode/sandbox';",
    "import { Worker } from 'node:worker_threads';",
    'const run = Function.prototype.call;',
  ],
  invalid: [
    { code: "import vm from 'node:vm';", errors: [{ messageId: 'notSandbox' }] },
    { code: "import { runInNewContext } from 'vm';", errors: [{ messageId: 'notSandbox' }] },
    { code: "const vm = require('vm');", errors: [{ messageId: 'notSandbox' }] },
    { code: "const vm = await import('node:vm');", errors: [{ messageId: 'notSandbox' }] },
    { code: 'const run = new Function("return 1");', errors: [{ messageId: 'notSandbox' }] },
  ],
});

tester.run('no-raw-timers', rules['no-raw-timers'], {
  valid: [
    'useTimeout(() => setOpen(false), 2000);',
    "import { setTimeout } from 'node:timers/promises';\nawait setTimeout(10);",
    'function run(setInterval) { setInterval(); }',
    'scheduler.setTimeout(tick, 5);',
  ],
  invalid: [
    { code: 'setTimeout(() => release(id), 0);', errors: [{ messageId: 'rawTimer', data: { name: 'setTimeout' } }] },
    { code: 'window.requestAnimationFrame(measure);', errors: [{ messageId: 'rawTimer', data: { name: 'window.requestAnimationFrame' } }] },
    { code: 'const id = setInterval(poll, 1000);', errors: [{ messageId: 'rawTimer' }] },
    { code: 'requestIdleCallback(warm);', errors: [{ messageId: 'rawTimer' }] },
  ],
});

tester.run('no-sync-fs', rules['no-sync-fs'], {
  valid: [
    "import fs from 'node:fs/promises';\nawait fs.readFile(p);",
    "import { createReadStream } from 'fs';\ncreateReadStream(p);",
    "import fs from 'fs';\nawait fs.promises.readFile(p);",
    'cache.readSync(key);',
  ],
  invalid: [
    { code: "import fs from 'fs';\nfs.readFileSync(p);", errors: [{ messageId: 'syncFs', data: { name: 'readFileSync' } }] },
    { code: "import * as fs from 'node:fs';\nfs.existsSync(p);", errors: [{ messageId: 'syncFs' }] },
    { code: "import { writeFileSync as write } from 'node:fs';\nwrite(p, d);", errors: [{ messageId: 'syncFs', data: { name: 'writeFileSync' } }] },
    { code: "const { statSync } = require('fs');\nstatSync(p);", errors: [{ messageId: 'syncFs' }] },
    { code: "require('fs').mkdirSync(p);", errors: [{ messageId: 'syncFs' }] },
    { code: "import fs from 'node:fs';\nfs.realpathSync(p);", errors: [{ messageId: 'syncRealpath' }] },
    { code: "import { realpathSync } from 'fs';\nrealpathSync(p);", errors: [{ messageId: 'syncRealpath' }] },
  ],
});

tester.run('no-adhoc-startup-error-match', rules['no-adhoc-startup-error-match'], {
  valid: [
    'const hint = findStartupFailureHint(result.error);',
    "if (error.code === 'MODULE_NOT_FOUND') return fallback();",
    "if ('ERR_MODULE_NOT_FOUND' !== err.code) throw err;",
    "const label = 'Module not installed';",
  ],
  invalid: [
    {
      code: "if (consoleOutput.includes(\"MODULE_NOT_FOUND\")) {\n  setMessage({ type: 'error', text: t('mcp.local.run.moduleNotFound') });\n}",
      errors: [{ messageId: 'adhocMatch', data: { marker: 'MODULE_NOT_FOUND' } }],
    },
    { code: 'const missing = /ModuleNotFoundError: (.+)/.exec(stderr);', errors: [{ messageId: 'adhocMatch', data: { marker: 'ModuleNotFoundError' } }] },
    { code: "if (text.startsWith(`Error: Cannot find module ${name}`)) warn();", errors: [{ messageId: 'adhocMatch' }] },
    { code: "const isMissing = stderr.includes(\"can't open file\");", errors: [{ messageId: 'adhocMatch' }] },
    { code: "const isMissing = codes.includes('MODULE_NOT_FOUND');", errors: [{ messageId: 'adhocMatch' }] },
  ],
});

tester.run('no-hand-rolled-file-retry', rules['no-hand-rolled-file-retry'], {
  valid: [
    "await retryTransientFileOperation(() => fs.readFile(file, 'utf8'), { label: 'storage-read' });",
    "await replaceFileWithRetry(temporary, target, { label: 'workspace-metadata-replace' });",
    // Telling the user a folder is not readable is not a retry.
    "try { await fs.readdir(dir); } catch (error) { if (error.code === 'EACCES' || error.code === 'EPERM') return forbidden(); }",
    // A live process the caller may not signal is still alive.
    "function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }",
    // Renaming a directory onto an existing one fails with EPERM on Windows: a collision, not a lock.
    "while (true) { try { await fs.rename(candidate, lock); return; } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error; } await wait(); }",
    // A loop over directory entries that skips unreadable ones.
    "for (const name of names) { try { await read(name); } catch (error) { if (error.code === 'EACCES') continue; throw error; } }",
    // A function defined inside a loop is not part of that loop's retry.
    "for (let i = 0; i < 3; i++) { handlers.push(() => { try { stop(); } catch (error) { return error.code === 'EPERM'; } }); }",
  ],
  invalid: [
    { code: "const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);", errors: [{ messageId: 'retryCode', data: { code: 'EBUSY' } }] },
    { code: "if (code === `EMFILE`) await sleep(10);", errors: [{ messageId: 'retryCode', data: { code: 'EMFILE' } }] },
    { code: "type Busy = 'EAGAIN';", errors: [{ messageId: 'retryCode', data: { code: 'EAGAIN' } }] },
    {
      code: "for (let attempt = 0; ; attempt++) { try { await fs.rename(a, b); break; } catch (error) { if (attempt >= 14 || !['EPERM', 'EACCES'].includes(error.code)) throw error; await sleep(5); } }",
      errors: [{ messageId: 'retryLoop' }],
    },
    {
      code: "while (true) { try { return await fs.unlink(file); } catch (error) { if (error.code !== 'EPERM') throw error; await delay(25); } }",
      errors: [{ messageId: 'retryLoop' }],
    },
    {
      code: "do { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (!isTransientFileError(error)) throw error; } await sleep(50); } while (tries++ < 3);",
      errors: [{ messageId: 'retryLoop' }],
    },
    {
      code: "for (let attempt = 0; attempt < 5; attempt++) { try { await fs.rm(dir, { recursive: true }); return; } catch (error) { if (error.code === 'EBUSY' || error.code === 'EPERM') continue; throw error; } }",
      errors: [{ messageId: 'retryLoop' }, { messageId: 'retryCode', data: { code: 'EBUSY' } }],
    },
  ],
});

tester.run('single-tool-approval-gate', rules['single-tool-approval-gate'], {
  valid: [
    'const on = requireApprovalOf(state.requireApproval);',
    'setRequireApproval(conversation.requireApproval ?? false);',
    'if (requireApproval || held.length > 0) hold();',
    "import { listPendingToolCalls } from '@/backend/execution/flow/toolApprovalRegistry';",
    {
      code: "import { registerPendingApproval } from '@/backend/execution/flow/toolApprovalRegistry';",
      filename: '/repo/src/backend/execution/flow/toolApprovalGate.ts',
    },
    {
      code: "import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';",
      filename: '/repo/src/app/api/approvals/[id]/route.ts',
    },
    { code: "sharedState.status = 'awaiting_tool_approval';", filename: '/repo/src/backend/execution/flow/runFlow.ts' },
  ],
  invalid: [
    { code: 'run({ requireApproval: state.requireApproval ?? true });', errors: [{ messageId: 'fallback', data: { name: 'requireApproval' } }] },
    { code: 'const gate = input.requireToolApproval ?? defaults.gate;', errors: [{ messageId: 'fallback', data: { name: 'requireToolApproval' } }] },
    { code: 'const gate = requireApproval || true;', errors: [{ messageId: 'fallback' }] },
    {
      code: "import { registerPendingApproval } from '@/backend/execution/flow/toolApprovalRegistry';",
      filename: '/repo/src/backend/services/model/adapters/newAdapter.ts',
      errors: [{ messageId: 'decisionPoint', data: { name: 'registerPendingApproval' } }],
    },
    {
      code: "import { applyApprovalDecision } from '../flow/resumeAfterApproval';",
      filename: '/repo/src/backend/services/scheduler/autoApprove.ts',
      errors: [{ messageId: 'decisionPoint', data: { name: 'applyApprovalDecision' } }],
    },
    {
      code: "state.status = 'awaiting_tool_approval';",
      filename: '/repo/src/backend/execution/flow/nodes/NewNode.ts',
      errors: [{ messageId: 'pauseWriter' }],
    },
    {
      code: "import * as approvals from '@/backend/execution/flow/toolApprovalRegistry';",
      filename: '/repo/src/backend/services/newService.ts',
      errors: [{ messageId: 'decisionPoint' }],
    },
    {
      code: "const { applyApprovalDecision } = await import('@/backend/execution/flow/resumeAfterApproval');",
      filename: '/repo/src/backend/services/newService.ts',
      errors: [{ messageId: 'decisionPoint' }],
    },
  ],
});

tester.run('mcp-feature-defaults', rules['mcp-feature-defaults'], {
  valid: [
    'const on = mcpAppsEnabled(config);',
    'if (config.enableMcpApps === false) off();',
    'const changed = detail.config?.enableMcpApps !== false;',
    'if (config.enableMcpApps || config.elicitation?.enabled) refuse();',
    {
      code: 'export const on = (config) => config.enableMcpApps === true;',
      filename: '/repo/src/shared/utils/mcpClientFeatures.ts',
    },
  ],
  invalid: [
    { code: 'const on = config.enableMcpApps === true;', errors: [{ messageId: 'compare', data: { name: 'enableMcpApps' } }] },
    { code: 'if (config.enableMcpSkills !== true) return;', errors: [{ messageId: 'compare', data: { name: 'enableMcpSkills' } }] },
    { code: 'const on = true === server?.enableMcpApps;', errors: [{ messageId: 'compare' }] },
    { code: 'const on = config.elicitation?.enabled === true;', errors: [{ messageId: 'compare', data: { name: 'elicitation.enabled' } }] },
  ],
});
