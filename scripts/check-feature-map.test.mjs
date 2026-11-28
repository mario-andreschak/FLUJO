import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFeatureMap, checkStepFiles, pageRoutes, parseEntry, SECTIONS } from './check-feature-map.mjs';

const entry = (title, routes, sections = SECTIONS) => [
  `# ${title}`,
  '',
  `Routes: ${routes.map((route) => `\`${route}\``).join(', ')}`,
  '',
  'What a user can do here.',
  ...sections.flatMap((section) => ['', `## ${section}`, '', '- item']),
].join('\n');

test('page files become routes, without route groups', () => {
  assert.deepEqual(pageRoutes(['page.tsx', 'flows/page.tsx', 'roles/[roleId]/edit/page.tsx', '(marketing)/about/page.tsx']), [
    '/', '/about', '/flows', '/roles/[roleId]/edit',
  ]);
});

test('an entry is parsed into its title, routes and sections', () => {
  assert.deepEqual(parseEntry(entry('Roles', ['/roles', '/roles/[roleId]'])), {
    title: 'Roles',
    routes: ['/roles', '/roles/[roleId]'],
    sections: SECTIONS,
  });
});

test('address variants with a query count as their page', () => {
  assert.deepEqual(parseEntry(entry('AI Setup', ['/models', '/models?add=1', '/models?edit=<id>'])).routes, ['/models']);
});

test('a complete map passes', () => {
  const entries = [{ name: 'home.md', content: entry('Home', ['/']) }, { name: 'agents.md', content: entry('Agents', ['/flows']) }];
  assert.deepEqual(checkFeatureMap(['/', '/flows'], entries, '- [Home](home.md)\n- [Agents](./agents.md)'), []);
});

test('a new page without an entry fails with a fix', () => {
  const [problem] = checkFeatureMap(['/', '/new-page'], [{ name: 'home.md', content: entry('Home', ['/']) }], '(home.md)');
  assert.match(problem, /\/new-page has no feature map entry/);
});

test('stale routes, duplicates, missing links and wrong sections fail', () => {
  const problems = checkFeatureMap(['/', '/flows'], [
    { name: 'home.md', content: entry('Home', ['/', '/gone']) },
    { name: 'agents.md', content: entry('Agents', ['/flows', '/'], ['Sub-features', 'Gotchas']) },
  ], '(home.md)');
  assert.ok(problems.some((problem) => /\/gone is not a page/.test(problem)));
  assert.ok(problems.some((problem) => /\/ is already covered by docs\/feature-map\/home\.md/.test(problem)));
  assert.ok(problems.some((problem) => /use exactly these sections/.test(problem)));
  assert.ok(problems.some((problem) => /link agents\.md/.test(problem)));
});

test('step files run only through the one bullet that names them, and must be valid', () => {
  const driving = (...bullets) => entry('Apps', ['/mcp']).replace('## Driving it with flujo-drive\n\n- item', ['## Driving it with flujo-drive', '', ...bullets].join('\n'));
  const named = (label, file) => `- **${label}**: \`node scripts/flujo-drive.mjs steps /mcp --file docs/feature-map/steps/${file}\` → "Done".`;
  const valid = () => [{ do: 'click', role: 'button', name: 'Go' }];
  assert.deepEqual(checkStepFiles([{ name: 'apps.md', content: driving(named('Drop', 'drop.json')) }], ['drop.json'], valid), []);
  const [unnamed] = checkStepFiles([{ name: 'apps.md', content: driving() }], ['drop.json'], valid);
  assert.match(unnamed, /drop\.json is not named by any "Driving it with flujo-drive" bullet, so nothing runs it/);
  const twice = checkStepFiles([{ name: 'apps.md', content: driving(named('One', 'drop.json'), named('Two', 'drop.json')) }], ['drop.json'], valid);
  assert.match(twice.join('\n'), /is named by .*\("One"\) and .*\("Two"\)/);
  const broken = checkStepFiles([{ name: 'apps.md', content: driving(named('Drop', 'gone.json')) }], [], () => { throw new Error('the step file does not exist'); });
  assert.match(broken.join('\n'), /apps\.md \("Drop"\): the step file does not exist/);
});
