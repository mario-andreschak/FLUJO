import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFeatureMap, pageRoutes, parseEntry, SECTIONS } from './check-feature-map.mjs';

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
