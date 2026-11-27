import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSweepCoverage } from '../check-feature-map.mjs';
import {
  DEFAULT_FILL, firstSentence, loadPlan, parseBullet, parseEntryChecks, parseOutcome, parseStepList, sweepOrder, tokenize,
} from './steps.mjs';

const MAP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/feature-map');

const entry = (driving) => [
  '# Settings', '', 'Routes: `/settings`', '', 'One page.', '',
  '## Sub-features', '', '- `settings-a`: a.', '',
  '## How to get to it (user POV)', '', '- Open it.', '',
  '## Driving it with flujo-drive', '', 'Preconditions: a throwaway instance. Nothing else needs to exist.', '', ...driving, '',
  '## Gotchas', '', '- None.',
].join('\n');

test('an open command becomes a visit plus the heading it promises', () => {
  const check = parseBullet('settings', '- **Open the page**: `node scripts/flujo-drive.mjs open /settings` → heading "Settings"; the "Network access" section is shown first.');
  assert.deepEqual(check, {
    id: 'settings/open-the-page', entry: 'settings', label: 'Open the page', status: 'auto',
    steps: [{ do: 'goto', route: '/settings' }, { do: 'wait-for', role: 'heading', name: 'Settings' }],
  });
});

test('a click command keeps its role and name, and a leading quote after → is checked as text', () => {
  const check = parseBullet('ai-setup', '- **Open the wizard**: `node scripts/flujo-drive.mjs click /models --role button --name "Connect AI" --then-shot ai-setup-wizard.png` → "Let’s connect your AI!" with three experience choices.');
  assert.deepEqual(check.steps, [
    { do: 'goto', route: '/models' },
    { do: 'click', role: 'button', name: 'Connect AI' },
    { do: 'expect-text', text: 'Let’s connect your AI!' },
  ]);
});

test('clicking a switch means making sure it is on, so walking entries in a row never turns it off', () => {
  const check = parseBullet('statistics', '- **Turn on experimental features**: use `steps` on `/settings`: click button "Experimental features", click switch "Enable experimental features". The setting is saved right away.');
  assert.equal(check.status, 'auto');
  assert.deepEqual(check.steps, [
    { do: 'goto', route: '/settings' },
    { do: 'click', role: 'button', name: 'Experimental features' },
    { do: 'check', role: 'switch', name: 'Enable experimental features' },
  ]);
});

test('a steps command reads the list after "The steps:", ignoring evidence and periods inside quotes', () => {
  const check = parseBullet('agents', '- **Build and save** (one session, because a draft is lost between commands): `node scripts/flujo-drive.mjs steps /flows --file agents-save.json`. The steps: click button "Start simple"; fill "Workflow goal"; click button "Create goal step"; expect-text "Agent saved."; then shot and aria.');
  assert.equal(check.status, 'auto');
  assert.deepEqual(check.steps, [
    { do: 'goto', route: '/flows' },
    { do: 'click', role: 'button', name: 'Start simple' },
    { do: 'fill', label: 'Workflow goal', value: DEFAULT_FILL },
    { do: 'click', role: 'button', name: 'Create goal step' },
    { do: 'expect-text', text: 'Agent saved.' },
  ]);
});

test('a written steps list keeps quoted values, drops asides in parentheses and uses the entry route by default', () => {
  const check = parseBullet('settings', '- **Set the limit**: `steps`: click radio "Custom size", fill label "Size limit (KB)" (whole numbers) with `32`, press Enter, then `aria` → the switch is on.', '/settings');
  assert.deepEqual(check.steps, [
    { do: 'goto', route: '/settings' },
    { do: 'click', role: 'radio', name: 'Custom size' },
    { do: 'fill', label: 'Size limit (KB)', value: '32' },
    { do: 'press', key: 'Enter' },
  ]);
});

test('a bullet that needs setup a fresh instance lacks is not run, with the reason kept whole', () => {
  const check = parseBullet('agents', '- **Delete an agent a Persona uses** (needs a Persona, so a Role first; see [Personas](personas.md)): save two agents.');
  assert.equal(check.status, 'needs');
  assert.equal(check.reason, 'needs a Persona, so a Role first; see [Personas](personas.md)');
});

test('a step with a placeholder needs a real value and is not run', () => {
  const check = parseBullet('roles', '- **Open the actions menu**: `node scripts/flujo-drive.mjs click /roles/<id> --role button --name "Role actions"` → menu items.');
  assert.equal(check.status, 'needs');
  assert.match(check.reason, /<id>/);
});

test('the sweep never presses controls that send data out, update or lock the app', () => {
  for (const name of ['Send', 'Update now', 'Set a custom encryption password', 'Public']) {
    const check = parseBullet('home', `- **Risky**: \`node scripts/flujo-drive.mjs click / --role button --name "${name}"\` → done.`);
    assert.equal(check.status, 'unsafe', name);
  }
});

test('prose the grammar does not cover is manual, and the reason names the words', () => {
  const check = parseBullet('apps', '- **Reach a setup path**: use `steps /mcp --file <steps.json>`: click button "Connect App", click "I have connection details", then `aria` → "Where does the app run?"');
  assert.equal(check.status, 'manual');
  assert.match(check.reason, /click "I have connection details"/);
  assert.equal(parseBullet('a', '- **Run it once**: in the same `steps` file, click button "Run now".').status, 'manual');
  assert.equal(parseBullet('a', '- **Start the tour**: in the same kind of run, click tab "Help".').status, 'manual');
});

test('helpers: sentences, tokens, lists and outcomes', () => {
  assert.equal(firstSentence('click "A. B" and `x.y`. Then more.'), 'click "A. B" and `x.y`');
  assert.deepEqual(tokenize('click /flows --role button --name "Start simple"'), ['click', '/flows', '--role', 'button', '--name', 'Start simple']);
  assert.match(parseStepList('').reason, /grammar|empty/);
  assert.deepEqual(parseOutcome(' dialog "Connect your AI" with more'), { do: 'wait-for', role: 'dialog', name: 'Connect your AI' });
  assert.equal(parseOutcome('the tour closes'), undefined);
});

test('an entry yields its checks without the Proof bullet, with wrapped lines joined', () => {
  const parsed = parseEntryChecks('settings.md', entry([
    '- **Open the page**: `node scripts/flujo-drive.mjs open /settings`',
    '  → heading "Settings".',
    '- **Proof**: an ARIA snapshot.',
  ]));
  assert.equal(parsed.title, 'Settings');
  assert.equal(parsed.preconditions, 'a throwaway instance. Nothing else needs to exist.');
  assert.deepEqual(parsed.checks.map((check) => [check.id, check.status, check.steps.length]), [['settings/open-the-page', 'auto', 2]]);
});

test('the sweep order follows the README feature list, then the rest alphabetically', () => {
  assert.deepEqual(sweepOrder(['b.md', 'a.md', 'home.md', 'z.md'], '- [Home](home.md)\n- [Z](./z.md)'), ['home.md', 'z.md', 'a.md', 'b.md']);
});

test('every real feature map entry keeps a step the sweep can run', () => {
  const names = readdirSync(MAP_DIR).filter((name) => name.endsWith('.md') && name !== 'README.md');
  assert.deepEqual(checkSweepCoverage(names.map((name) => ({ name, content: readFileSync(path.join(MAP_DIR, name), 'utf8') }))), []);
  assert.deepEqual(checkSweepCoverage([{ name: 'x.md', content: entry(['- **Look**: read the page.']) }]).length, 1);
  const plan = loadPlan(MAP_DIR, { only: ['settings'] });
  assert.equal(plan.length, 1);
  assert.throws(() => loadPlan(MAP_DIR, { only: ['no-such-page'] }), /No feature map entry named no-such-page/);
});
