/**
 * Recurrence guard (issue #457).
 *
 * Two test files reached `main` in a state where they could not be parsed
 * (a duplicated `const` plus a duplicated object key in one, a stray `});`
 * closing a `describe` early in the other). Jest does report those as
 * "Test suite failed to run", but nothing in CI ran Jest, and `tsc --noEmit`
 * aborts further diagnostics after the first fatal syntax error — so the
 * second broken file stayed invisible even when someone did run it locally.
 *
 * This guard transpiles *every* file the Jest projects collect and reports all
 * syntax errors at once, in a single fast suite, so a non-executing test file
 * can never hide behind another one's failure.
 *
 * It deliberately uses the TypeScript transpiler (no type-checking): the
 * question here is only "does this file parse", which is exactly what decides
 * whether Jest can execute it.
 */

import { promises as fs } from 'fs';
import path from 'path';
import micromatch from 'micromatch';
import ts from 'typescript';
import { ALL_TEST_GLOBS } from '../../jest.testMatch.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const TESTS_DIR = path.join(ROOT, '__tests__');
const TEST_FILE = /\.(test|spec)\.tsx?$/;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full)));
    } else if (TEST_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function syntaxErrorsIn(source: string, fileName: string): string[] {
  const transpiled = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.Preserve,
      esModuleInterop: true,
      isolatedModules: true,
    },
  });
  return (transpiled.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      if (diagnostic.file && typeof diagnostic.start === 'number') {
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return `${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`;
      }
      return `TS${diagnostic.code}: ${message}`;
    });
}

describe('every collected test file parses', () => {
  it('reports no syntax errors across the whole __tests__ tree', async () => {
    const files = await walk(TESTS_DIR);
    // Sanity: the walker actually found the suite (guards against a broken walk).
    expect(files.length).toBeGreaterThan(0);

    const collected = files.filter((file) =>
      micromatch.isMatch(path.relative(ROOT, file).replace(/\\/g, '/'), ALL_TEST_GLOBS),
    );
    expect(collected.length).toBeGreaterThan(0);

    const broken: string[] = [];
    for (const file of collected) {
      const relative = path.relative(ROOT, file).replace(/\\/g, '/');
      const source = await fs.readFile(file, 'utf8');
      for (const error of syntaxErrorsIn(source, file)) {
        broken.push(`${relative}(${error})`);
      }
    }

    // If this fails, the listed files cannot be executed by Jest at all. Fix
    // the syntax — do NOT delete the assertion or exclude the file.
    expect(broken).toEqual([]);
  }, 300_000);

  it('detects a deliberately broken file (negative control)', () => {
    const broken = syntaxErrorsIn(
      "describe('x', () => {\n  it('y', () => {});\n});\n});\n",
      path.join(TESTS_DIR, 'virtual', 'broken.test.ts'),
    );
    expect(broken.length).toBeGreaterThan(0);

    const duplicated = syntaxErrorsIn(
      'const a = 1;\nconst a = 2;\n',
      path.join(TESTS_DIR, 'virtual', 'duplicate.test.ts'),
    );
    // A duplicate declaration is a *semantic* error (ts2451): the transpiler
    // cannot see it, which is why `npm run typecheck` remains part of CI.
    expect(duplicated).toEqual([]);
  });
});
