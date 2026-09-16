import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'src/app');
const destination = path.join(root, 'docs/api-reference/routes.md');
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function routes(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? routes(file) : entry.name === 'route.ts' ? [file] : [];
  });
}

function exportedMethods(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const entry of statement.exportClause.elements) if (methods.has(entry.name.text)) found.add(entry.name.text);
    } else if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      const names = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map(entry => entry.name.getText(source))
        : ts.isFunctionDeclaration(statement) ? [statement.name?.text] : [];
      for (const name of names) if (methods.has(name)) found.add(name);
    }
  }
  if (!found.size) throw new Error(`No explicit HTTP methods found in ${path.relative(root, file)}`);
  return [...found].sort().join(', ');
}

const rows = routes(app).map(file => {
  const relative = path.relative(app, path.dirname(file)).split(path.sep).filter(part => !/^\(.*\)$/.test(part));
  const route = '/' + relative.map(part => part.replace(/^\[\[?([^\]]+)\]\]?$/, '{$1}')).join('/');
  const source = path.relative(root, file).split(path.sep).join('/');
  return { route, methods: exportedMethods(file), source };
}).sort((a, b) => a.route < b.route ? -1 : a.route > b.route ? 1 : 0);

const output = [
  '# HTTP route inventory', '',
  'Generated from the App Router source by `node scripts/generate-api-inventory.mjs`. Do not edit this table by hand.', '',
  'This inventory lists explicit handler exports, not a public stability guarantee or complete request schema. Next.js may supply implicit HEAD/OPTIONS behavior. Internal administration routes can execute code or disclose secrets; obey their workspace, unlock, exposure, and worker-auth requirements. See the [integration guide](README.md) and the curated in-app `/docs` reference.', '',
  `Route files: ${rows.length}.`, '',
  '| Path | Explicit methods | Handler |', '| --- | --- | --- |',
  ...rows.map(row => `| \`${row.route}\` | ${row.methods} | [source](../../${row.source}) |`), '',
].join('\n');

if (process.argv.includes('--check')) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8').replace(/\r\n/g, '\n') !== output) {
    console.error('API route inventory is stale. Run node scripts/generate-api-inventory.mjs.');
    process.exitCode = 1;
  } else console.log(`API inventory current: ${rows.length} route files.`);
} else {
  fs.writeFileSync(destination, output);
  console.log(`Wrote ${rows.length} routes to docs/api-reference/routes.md.`);
}
