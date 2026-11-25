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
