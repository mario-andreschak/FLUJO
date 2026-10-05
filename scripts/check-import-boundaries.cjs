const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const LAYERS = new Set(['backend', 'frontend', 'shared']);
const printer = ts.createPrinter({ removeComments: true });
const posix = (value) => value.split(path.sep).join('/');
const edgeKey = ({ from, to, declaration }) => JSON.stringify([from, to, declaration]);

function layerOf(file) {
  const parts = file.split('/');
  // Windows resolves BACKEND and backend to the same directory. Apply the
  // resolver's platform casing rule before classifying the resolved target.
  const sourceRoot = ts.sys.useCaseSensitiveFileNames ? parts[0] : parts[0]?.toLowerCase();
  const layer = ts.sys.useCaseSensitiveFileNames ? parts[1] : parts[1]?.toLowerCase();
  return sourceRoot === 'src' && LAYERS.has(layer) ? layer : undefined;
}

function forbidden(from, to) {
  return from === 'shared' ? to !== 'shared' : from !== to && to !== 'shared';
}

function moduleLiteral(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  if (ts.isCallExpression(node) && (
    node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  )) return node.arguments[0];
  return undefined;
}

/** Direct dependencies only. This is an architecture guard, not bundle analysis. */
function inspectImportBoundaries(root, exceptions = []) {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!config || config.errors.length) {
    throw new Error(config?.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n') || 'Missing TypeScript configuration');
  }
  // Walk the layers explicitly: tsconfig's include/exclude is not an exemption
  // from the architecture contract. Ignore symlinks and non-source artifacts.
  const files = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(file);
    }
  }
  for (const layer of LAYERS) walk(path.join(root, 'src', layer));
  const crossings = [];
  const cache = ts.createModuleResolutionCache(root, (file) => ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(), config.options);
  for (const file of files.sort()) {
    const from = posix(path.relative(root, file));
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      const literal = moduleLiteral(node);
      if (literal && ts.isStringLiteralLike(literal)) {
        const resolved = ts.resolveModuleName(literal.text, file, config.options, ts.sys, cache).resolvedModule;
        const to = resolved && posix(path.relative(root, resolved.resolvedFileName));
        const targetLayer = to && layerOf(to);
        if (targetLayer && forbidden(layerOf(from), targetLayer)) {
          crossings.push({
            from,
            to,
            declaration: printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, ' ').trim(),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  const allowed = new Set();
  for (const entry of exceptions) {
    if (!entry.reason?.trim() || !entry.from || !entry.to || !entry.declaration) {
      throw new Error('Every import-boundary exception needs from, to, declaration and a removal reason.');
    }
    const key = edgeKey(entry);
    if (allowed.has(key)) throw new Error(`Duplicate import-boundary exception: ${entry.from}`);
    allowed.add(key);
  }
  const present = new Set(crossings.map(edgeKey));
  return {
    files: files.length,
    crossings,
    violations: crossings.filter((edge) => !allowed.has(edgeKey(edge))),
    stale: exceptions.filter((edge) => !present.has(edgeKey(edge))),
  };
}

function main() {
  const root = path.resolve(__dirname, '..');
  const debt = JSON.parse(fs.readFileSync(path.join(__dirname, 'import-boundary-debt.json'), 'utf8'));
  const result = inspectImportBoundaries(root, debt.exceptions);
  for (const edge of result.violations) {
    process.stderr.write(`${edge.from}:${edge.line} must not depend on ${edge.to}: ${edge.declaration}\n`);
  }
  for (const edge of result.stale) process.stderr.write(`Remove stale import-boundary exception: ${edge.from} -> ${edge.to}\n`);
  process.stdout.write(`Checked ${result.files} source files; ${result.crossings.length} layer crossings; ${result.violations.length} new crossings; ${result.stale.length} stale exceptions.\n`);
  process.exitCode = result.violations.length || result.stale.length ? 1 : 0;
}

module.exports = { edgeKey, inspectImportBoundaries };
if (require.main === module) main();
