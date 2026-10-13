const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ts = require('typescript');

/** Compile this one pure cluster and execute it without a dependency install. */
function runLayoutProcess(sourceDirectory, injectRuntimeDependency = false) {
  const tempParent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, 'flujo-layout-process-'));
  const declarations = {};
  try {
    for (const name of ['autoLayout', 'tidyLayout', 'layoutGeometry']) {
      const source = fs.readFileSync(path.join(sourceDirectory, `${name}.ts`), 'utf8');
      const ast = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
      const printer = ts.createPrinter({ removeComments: true });
      const body = ast.statements.filter((statement) => !ts.isImportDeclaration(statement))
        .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, ast)).join('\n');
      declarations[name] = createHash('sha256').update(body).digest('hex');
      const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      }).outputText;
      fs.writeFileSync(path.join(root, `${name}.js`), compiled);
    }
    if (injectRuntimeDependency) fs.appendFileSync(path.join(root, 'autoLayout.js'), "\nrequire('node:fs');\n");
    const result = spawnSync(process.execPath, [path.join(__dirname, 'layoutProcess.cjs'), root], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    });
    return {
      status: result.status,
      error: result.error?.message,
      stderr: result.stderr,
      declarations,
      observation: result.status === 0 ? JSON.parse(result.stdout) : undefined,
    };
  } finally {
    // root comes only from mkdtemp above; never remove a caller-provided path.
    const relative = path.relative(tempParent, path.resolve(root));
    if (!relative.startsWith('flujo-layout-process-') || relative.includes(path.sep) || path.isAbsolute(relative)) {
      throw new Error('Layout fixture cleanup escaped its temporary directory.');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { runLayoutProcess };
