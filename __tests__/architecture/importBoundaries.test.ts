import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { inspectImportBoundaries } = require('../../scripts/check-import-boundaries.cjs');
const debt = require('../../scripts/import-boundary-debt.json');

describe('backend/frontend/shared import direction', () => {
  let root: string;

  function write(relative: string, source: string) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-import-boundaries-'));
    write('tsconfig.json', JSON.stringify({ compilerOptions: {
      module: 'ESNext', moduleResolution: 'Bundler', allowJs: true,
      paths: { '@/*': ['./src/*'], '#server/*': ['./src/backend/*'] },
    } }));
    for (const layer of ['backend', 'frontend', 'shared']) {
      write(`src/${layer}/value.ts`, 'export const value = 1; export type Value = string;');
    }
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([
    "import { value } from '@/backend/value';",
    "import type { Value } from '@/backend/value';",
    "import { type Value } from '@/backend/value';",
    "export { value } from '../backend/value';",
    "export type { Value } from '../backend/value';",
    "export * from '../backend/value';",
    "const load = () => import('../backend/value.js');",
    "const value = require('../backend/value');",
    "import value = require('../backend/value');",
    "type Value = import('../backend/value').Value;",
    "import { value } from '#server/value';",
  ])('rejects an unreviewed frontend dependency: %s', (source) => {
    write('src/frontend/crossing.ts', source);
    const result = inspectImportBoundaries(root);
    expect(result.violations).toEqual([expect.objectContaining({
      from: 'src/frontend/crossing.ts', to: 'src/backend/value.ts', line: 1,
    })]);
  });

  it.each([
    ['backend', 'frontend'], ['shared', 'frontend'], ['shared', 'backend'],
  ])('rejects %s importing %s', (from, to) => {
    write(`src/${from}/crossing.ts`, `export * from '../${to}/value';`);
    expect(inspectImportBoundaries(root).violations).toHaveLength(1);
  });

  it('allows same-layer and shared dependencies and ignores path mentions', () => {
    write('src/frontend/valid.ts', `
      import { value } from './value';
      export type { Value } from '@/shared/value';
      // import { value } from '@/backend/value';
      const documentation = "import('@/backend/value')";
    `);
    write('src/backend/valid.ts', "export * from '@/shared/value';");
    expect(inspectImportBoundaries(root).violations).toEqual([]);
  });

  it('does not exempt source excluded from typechecking', () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: {
      module: 'ESNext', moduleResolution: 'Bundler', paths: { '@/*': ['./src/*'] },
    }, exclude: ['src/frontend/crossing.ts'] }));
    write('src/frontend/crossing.ts', "export * from '@/backend/value';");
    expect(inspectImportBoundaries(root).violations).toHaveLength(1);
  });

  it('pins an exception to its declaration and detects removed debt', () => {
    write('src/frontend/crossing.ts', "import type { Value } from '@/backend/value';");
    const [edge] = inspectImportBoundaries(root).crossings;
    const exceptions = [{ ...edge, reason: 'Move this DTO to shared.' }];
    expect(inspectImportBoundaries(root, exceptions).violations).toEqual([]);
    write('src/frontend/crossing.ts', "import { value } from '@/backend/value';");
    const changed = inspectImportBoundaries(root, exceptions);
    expect(changed.violations).toHaveLength(1);
    expect(changed.stale).toHaveLength(1);
    write('src/frontend/crossing.ts', "import type { Value } from '@/shared/value';");
    expect(inspectImportBoundaries(root, exceptions).stale).toHaveLength(1);
  });

  it('requires a removal reason and rejects duplicate exceptions', () => {
    write('src/frontend/crossing.ts', "export * from '@/backend/value';");
    const [edge] = inspectImportBoundaries(root).crossings;
    expect(() => inspectImportBoundaries(root, [edge])).toThrow('removal reason');
    const exception = { ...edge, reason: 'Move the DTO to shared.' };
    expect(() => inspectImportBoundaries(root, [exception, exception])).toThrow('Duplicate');
  });

  it('keeps repository crossings within the reviewed debt manifest', () => {
    const result = inspectImportBoundaries(path.resolve(__dirname, '../..'), debt.exceptions);
    expect(result.violations).toEqual([]);
    expect(result.stale).toEqual([]);
  });
});
