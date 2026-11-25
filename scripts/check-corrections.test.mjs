import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  adoptAgentsTable, agentsTableRows, checkAgents, checkCorrections, ciCommands, parseCorrection, run, runsFile, slugFor,
} from './check-corrections.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const WORKFLOW = `
on:
  pull_request:
    branches: [main]
jobs:
  lint:
    steps:
      - run: npm run lint:all
      - run: npm run test:checks
      - run: node --test tests/installer-repository.test.mjs
  test:
    steps:
      - run: npm run test:ci
`;
const MANUAL_WORKFLOW = 'on:\n  workflow_dispatch:\njobs:\n  soak:\n    steps:\n      - run: node --test scripts/soak.test.mjs\n';

function fakeRepo(files = {}) {
  const scripts = {
    'lint:all': 'eslint src __tests__ scripts --max-warnings=0',
    'test:checks': 'node --test scripts/check-corrections.test.mjs scripts/check-feature-map.test.mjs',
    'test:ci': 'node scripts/run-local-jest.cjs --ci',
    'journey:first-use': 'node scripts/first-journey/run.mjs',
  };
  const contents = {
    'src/utils/retry.ts': 'export function retryRead() {}',
    '__tests__/chat/burst.test.ts': '',
    '__tests__/enduringAgents/sweep.test.ts': '',
    'scripts/check-feature-map.test.mjs': '',
    'scripts/forgotten.test.mjs': '',
    'scripts/soak.test.mjs': '',
    'tests/installer-repository.test.mjs': '',
    'scripts/first-journey/run.mjs': '',
    ...files,
  };
  return {
    exists: (file) => Object.hasOwn(contents, file.replace(/\/$/, '')),
    read: (file) => contents[file] ?? '',
    topLevel: new Set(['src', 'scripts', '__tests__', 'tests', 'docs']),
    scripts,
    ci: ciCommands([{ name: 'verify.yml', content: WORKFLOW }, { name: 'soak.yml', content: MANUAL_WORKFLOW }], scripts),
    eslintConfig: "rules: { 'flujo/no-double-cast': 'error', 'react-hooks/refs': 'error', 'flujo/off-rule': 'off' }",
    flujoRules: new Set(['no-double-cast', 'off-rule']),
  };
}

const rule = (name, content) => ({ name, content });

test('a rule file is parsed into its rule, checks and prose', () => {
  assert.deepEqual(parseCorrection([
    '# Reads retry before they refuse',
    '',
    'Why it matters.',
    '',
    'Enforced by:',
    '- `retryRead` in `src/utils/retry.ts`',
    '- `__tests__/chat/burst.test.ts`',
    '',
    'Verified by:',
    '- `npm run journey:first-use`',
  ].join('\r\n')), {
    title: 'Reads retry before they refuse',
    body: 'Why it matters.',
    enforcedBy: ['`retryRead` in `src/utils/retry.ts`', '`__tests__/chat/burst.test.ts`'],
    verifiedBy: ['`npm run journey:first-use`'],
    prose: '',
  });
});

test('CI means the steps of pull request workflows and the npm scripts they call', () => {
  const { scripts, text } = fakeRepo().ci;
  assert.deepEqual([...scripts].sort(), ['lint:all', 'test:checks', 'test:ci']);
  assert.equal(runsFile(text, 'scripts/check-feature-map.test.mjs'), true);
  assert.equal(runsFile(text, 'tests/installer-repository.test.mjs'), true);
  assert.equal(runsFile(text, 'scripts/soak.test.mjs'), false, 'a manual workflow is not CI');
  assert.equal(runsFile("const ciOnly = ['scripts/workflow-contract.mjs'];", 'scripts/workflow-contract.mjs'), false, 'a mention in code is not a run');
  assert.equal(runsFile('node --test scripts/first-journey/run.test.mjs', 'scripts/run.test.mjs'), false);
});

test('rules whose checks exist and run in CI pass', () => {
  assert.deepEqual(checkCorrections([
    rule('reads-retry.md', '# Reads retry\n\nEnforced by:\n- `retryRead` in `src/utils/retry.ts`\n- `__tests__/chat/burst.test.ts`\n'),
    rule('no-double-cast.md', '# No double casts\n\nEnforced by: `flujo/no-double-cast`\n'),
    rule('hooks.md', '# Hooks follow the rules\n\nEnforced by:\n- `react-hooks/*` in `eslint.config.mjs`\n'),
    rule('installer.md', '# Installers keep the files\n\nEnforced by:\n- `tests/installer-repository.test.mjs`\n'),
    rule('journey.md', '# New users get through\n\nVerified by:\n- `npm run journey:first-use` (`scripts/first-journey/run.mjs`)\n'),
    rule('resilience.md', '# Resilience over refusal\n\nProse: whether to wait or refuse needs judgment.\n'),
  ], fakeRepo({ 'eslint.config.mjs': '' })), []);
});

test('a rule that names something missing fails with the fix', () => {
  const problems = checkCorrections([
    rule('broken.md', [
      '# Uses `src/utils/gone.ts`',
      '',
      'Enforced by:',
      '- `__tests__/chat/renamed.test.ts`',
      '- `retryRead` in `retry.ts`',
      '- `flujo/no-such-rule`, `flujo/off-rule`',
      '- `npm run check:nothing`',
      '- `retryWrite` in `src/utils/retry.ts`',
      '- the burst test',
    ].join('\n')),
  ], fakeRepo());
  const expected = [
    /`src\/utils\/gone\.ts` does not exist/,
    /`__tests__\/chat\/renamed\.test\.ts` does not exist\. Fix the path/,
    /`retry\.ts` does not exist\. Write the path from the repository root/,
    /lint rule `flujo\/no-such-rule` is not switched on/,
    /lint rule `flujo\/off-rule` is not switched on/,
    /`npm run check:nothing` is not a script/,
    /`retryWrite` is not in `src\/utils\/retry\.ts`/,
    /"the burst test" names no check/,
    /nothing under "Enforced by" runs in CI/,
  ];
  for (const pattern of expected) assert.ok(problems.some((problem) => pattern.test(problem)), `${pattern} in\n${problems.join('\n')}`);
});

test('a check that CI never runs does not count as enforcement', () => {
  const problems = checkCorrections([
    rule('forgotten.md', '# Forgotten\n\nEnforced by:\n- `scripts/forgotten.test.mjs`\n'),
    rule('enduring.md', '# Enduring\n\nEnforced by:\n- `__tests__/enduringAgents/sweep.test.ts`\n'),
    rule('journey.md', '# Journey\n\nEnforced by:\n- `npm run journey:first-use`\n'),
  ], fakeRepo());
  assert.ok(problems.some((problem) => /forgotten\.md: `scripts\/forgotten\.test\.mjs` is not run by CI\. Add it to the "test:checks"/.test(problem)));
  assert.ok(problems.some((problem) => /enduring\.md: .*is not run by CI\. Pull request CI skips __tests__\/enduringAgents/.test(problem)));
  assert.ok(problems.some((problem) => /journey\.md: nothing under "Enforced by" runs in CI/.test(problem)));
});

test('file names, titles and empty rules are checked', () => {
  const problems = checkCorrections([
    rule('Bad Name.md', '# One rule\n\nProse: judgment.\n'),
    rule('no-title.md', 'Enforced by:\n- `__tests__/chat/burst.test.ts`\n'),
    rule('empty.md', '# Empty\n\nJust words.\n'),
    rule('again.md', '# One rule\n\nProse: judgment.\n'),
  ], fakeRepo());
  assert.ok(problems.some((problem) => /Bad Name\.md: name the file in lower-case words/.test(problem)));
  assert.ok(problems.some((problem) => /no-title\.md: start with a "# /.test(problem)));
  assert.ok(problems.some((problem) => /empty\.md: add "Enforced by:"/.test(problem)));
  assert.ok(problems.some((problem) => /again\.md: states the same rule as docs\/corrections\/Bad Name\.md/.test(problem)));
});

const AGENTS = [
  '# Corrections become checks',
  '',
  'Intro.',
  '',
  '| Rule | Enforced by |',
  '|---|---|',
  '| No `as unknown as` casts | `flujo/no-double-cast` |',
  '| A burst waits its turn; none is refused | `__tests__/chat/burst.test.ts`; `retryRead` in `src/utils/retry.ts` |',
  '| Resilience over refusal | Prose: needs judgment |',
  '',
  '# Resilience over refusal',
  '',
  '| Not | a rule row |',
].join('\n');

test('rows written into the AGENTS.md table fail and say how to move them', () => {
  assert.equal(agentsTableRows(AGENTS).length, 3);
  const [problem] = checkAgents(AGENTS);
  assert.match(problem, /3 rule row\(s\) are written into the table.*--adopt/);
  assert.deepEqual(checkAgents('# Corrections become checks\n\nSee docs/corrections/.\n'), []);
  assert.match(checkAgents('# Something else\n')[0], /keep the "# Corrections become checks" section/);
});

test('--adopt moves every row into its own file without losing one', () => {
  const { agents, files, notes } = adoptAgentsTable(AGENTS, []);
  assert.deepEqual(files.map(({ name }) => name), ['no-as-unknown-as-casts.md', 'burst-waits-its-turn-none-is-refused.md', 'resilience-over-refusal.md']);
  assert.equal(files[1].content, '# A burst waits its turn; none is refused\n\nEnforced by:\n- `__tests__/chat/burst.test.ts`\n- `retryRead` in `src/utils/retry.ts`\n');
  assert.equal(files[2].content, '# Resilience over refusal\n\nProse: needs judgment\n');
  assert.deepEqual(notes, []);
  assert.deepEqual(checkAgents(agents), []);
  assert.match(agents, /\| Not \| a rule row \|/, 'tables in other sections stay');
  assert.deepEqual(checkCorrections(files.slice(1), fakeRepo()), []);
});

test('--adopt after a merge skips rules already moved and reports rows another branch changed', () => {
  const { files, notes } = adoptAgentsTable(AGENTS, [
    rule('no-double-cast.md', '# No `as unknown as` casts\n\nEnforced by: `__tests__/casts.test.ts`\n'),
    rule('burst-waits.md', '# A burst waits its turn\n\nEnforced by:\n- `__tests__/chat/burst.test.ts`\n'),
    rule('resilience.md', '# Resilience over refusal, as AGENTS.md describes it\r\n\r\nProse: needs judgment.\r\n'),
  ]);
  assert.deepEqual(files.map(({ name }) => name), ['burst-waits-its-turn-none-is-refused.md'], 'an improved copy of the resilience row stays as it is');
  assert.deepEqual(notes, [
    'no-double-cast.md already holds this rule, but its row also named: `flujo/no-double-cast`',
    'burst-waits-its-turn-none-is-refused.md looks like a changed copy of burst-waits.md; keep one of the two.',
  ]);
});

test('file names come from the rule, short and without small words at the ends', () => {
  const taken = new Set();
  assert.equal(slugFor('A store read that fails never becomes a write of an empty store', taken), 'store-read-that-fails-never-becomes-a-write.md');
  assert.equal(slugFor("FLUJO's own system prompt", taken), 'flujos-own-system-prompt.md');
  assert.equal(slugFor("FLUJO's own system prompt", taken), 'flujos-own-system-prompt-2.md');
});

test('every rule in this repository names checks that exist and that CI runs', () => {
  const output = [];
  const status = run({ cwd: ROOT, argv: [], log: (line) => output.push(line), error: (line) => output.push(line) });
  assert.equal(status, 0, output.join('\n'));
});
