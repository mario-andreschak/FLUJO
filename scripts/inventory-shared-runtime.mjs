import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Source inventory for #212/#573. This records candidates for review, never
// treats a lexical match or an exported method as an authorization proof.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'docs/architecture/shared-runtime-inventory.json');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard',
  '--', 'src/backend', 'src/utils', 'src/app').split('\0').filter(Boolean))]
  .filter(file => /\.[cm]?[jt]sx?$/.test(file)).sort();
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const statePattern = /declare\s+global|\b(?:global|globalThis)\s*(?:\.|\[)|\bnew\s+(?:Map|Set|WeakMap|WeakSet)\s*(?:<|\()|\bgetInstance\s*\(/;
const state = [];
const routes = [];
const routeMethods = [];
const sourceHash = createHash('sha256');

for (const file of files) {
  const absolute = path.join(root, file);
  if (!lstatSync(absolute).isFile()) throw new Error(`Inventory requires a regular source file: ${file}`);
  const source = readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n');
  sourceHash.update(file).update('\0').update(source).update('\0');
  const isRoute = file.startsWith('src/app/') && /\/route\.[jt]s$/.test(file);
  if (!file.startsWith('src/app/') || isRoute) {
    source.split('\n').forEach((line, index) => {
      if (statePattern.test(line)) state.push({ file, line: index + 1, state: line.trim() });
    });
  }
  if (!isRoute) continue;
  routes.push(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error(`Cannot parse route exports: ${file}`);
  const exported = new Set();
  const unresolvedExports = [];
  for (const statement of ast.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) exported.add(element.name.text);
        }
      } else {
        unresolvedExports.push(statement.getText(ast));
      }
      continue;
    }
    if (!ts.canHaveModifiers(statement)
      || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) exported.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
        else unresolvedExports.push(declaration.name.getText(ast));
      }
    }
  }
  const explicitMethods = methods.filter(method => exported.has(method));
  // Next provides HEAD for GET and OPTIONS when not explicitly exported.
  // Neither an implicit method nor an export is an authorization classification.
  const implicitMethods = methods.filter(method => !exported.has(method)
    && (method === 'OPTIONS' || (method === 'HEAD' && exported.has('GET'))));
  routeMethods.push({ file, explicitMethods, implicitMethods, unresolvedExports,
    ownershipReviewed: false });
}

const inventory = {
  schemaVersion: 2,
  sourceRevision: git('rev-parse', 'HEAD'),
  sourceTreeDigest: sourceHash.digest('hex'),
  method: 'Deterministic source survey: lexical state candidates in src/backend, src/utils and App Router handlers; TypeScript AST route exports, with Next implicit HEAD/OPTIONS recorded separately.',
  limitations: 'Matches include local allocations and comments and can miss other mutable state. Re-exports identify method names but do not inspect their implementation. Each candidate requires semantic ownership review; OS isolation, service authorization, background work, and revocation are not established by this inventory.',
  completenessVerified: false,
  reviewAccepted: false,
  sourceFileCount: files.length,
  state,
  routes,
  routeMethods,
  stateBoundary: 'Every listed state occurrence stays in a dedicated owner runtime; must never load in a shared controller. Semantic and OS/runtime qualification pending #574.',
  routeBoundary: 'Every listed route requires initiating principal/current resource grants before private runtime dispatch. Unknown methods deny. Implementation not verified.',
};
writeFileSync(destination, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(JSON.stringify({ sourceRevision: inventory.sourceRevision,
  sourceTreeDigest: inventory.sourceTreeDigest, sourceFiles: files.length,
  stateCandidates: state.length, stateFiles: new Set(state.map(entry => entry.file)).size,
  routes: routes.length, explicitMethods: routeMethods.reduce((sum, route) => sum + route.explicitMethods.length, 0),
  unresolvedRoutes: routeMethods.filter(route => route.unresolvedExports.length).map(route => route.file) }));
