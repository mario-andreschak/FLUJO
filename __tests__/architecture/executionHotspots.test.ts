import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { inspectHotspotImports } = require('../../scripts/check-import-boundaries.cjs');
const contract = require('../../scripts/execution-hotspots.json');

describe('modules split out of an execution hotspot never import it back', () => {
  let root: string;

  function write(relative: string, source: string) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }

  const hotspot = (modules: string[] = [], backImportDebt: unknown[] = []) => ({
    hotspots: [{ file: 'src/backend/big.ts', maxLines: 100, modules }],
    backImportDebt,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-hotspot-imports-'));
    write('tsconfig.json', JSON.stringify({ compilerOptions: {
      module: 'ESNext', moduleResolution: 'Bundler', paths: { '@/*': ['./src/*'] },
    } }));
    write('src/backend/big.ts', "import { helper } from './helper';\nexport const big = helper;");
    write('src/backend/helper.ts', 'export const helper = 1;');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([
    "import { big } from './big';",
    "import type { big } from '@/backend/big';",
    "const load = () => import('./big');",
    "type Big = import('./big').Big;",
    "export * from './big';",
  ])('rejects a module the hotspot uses importing it back: %s', (source) => {
    write('src/backend/helper.ts', `${source}\nexport const helper = 1;`);
    expect(inspectHotspotImports(root, hotspot()).violations).toEqual([
      { from: 'src/backend/helper.ts', to: 'src/backend/big.ts', line: 1 },
    ]);
  });

  it('rejects a listed split-out module even when the hotspot no longer imports it', () => {
    write('src/backend/split.ts', "import { big } from './big';\nexport const split = big;");
    expect(inspectHotspotImports(root, hotspot()).violations).toEqual([]);
    expect(inspectHotspotImports(root, hotspot(['src/backend/split.ts'])).violations).toEqual([
      { from: 'src/backend/split.ts', to: 'src/backend/big.ts', line: 1 },
    ]);
  });

  it('allows one-way imports and ignores path mentions', () => {
    write('src/backend/helper.ts', "// import { big } from './big';\nconst text = \"import('./big')\";\nexport const helper = text;");
    expect(inspectHotspotImports(root, hotspot(['src/backend/helper.ts']))).toEqual({ missing: [], violations: [], stale: [] });
  });

  it('reports a listed file that does not exist', () => {
    expect(inspectHotspotImports(root, hotspot(['src/backend/gone.ts'])).missing).toEqual(['src/backend/gone.ts']);
  });

  it('allows reviewed debt with a reason and reports it once it is gone', () => {
    write('src/backend/helper.ts', "const load = () => import('./big');\nexport const helper = load;");
    const debt = [{ from: 'src/backend/helper.ts', to: 'src/backend/big.ts', reason: 'Pass the loader in.' }];
    expect(inspectHotspotImports(root, hotspot([], debt)).violations).toEqual([]);
    write('src/backend/helper.ts', 'export const helper = 1;');
    expect(inspectHotspotImports(root, hotspot([], debt)).stale).toEqual(debt);
    expect(() => inspectHotspotImports(root, hotspot([], [{ from: 'src/backend/helper.ts', to: 'src/backend/big.ts' }])))
      .toThrow('removal reason');
  });

  it('keeps the repository within its reviewed back-import debt', () => {
    expect(inspectHotspotImports(path.resolve(__dirname, '../..'), contract)).toEqual({ missing: [], violations: [], stale: [] });
  });
});
