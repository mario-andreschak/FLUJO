/** Fixed public security modules for smoke equipment in production-only images.
 * Runtime images contain neither source TypeScript nor the development compiler.
 * No policy, credential, account or environment file is read by this build. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'scripts', 'compiled-security');
await fs.mkdir(destination, { recursive: true });
for (const name of ['ownerCredentials', 'windowsPrivateAuthority']) {
  const filename = path.join(root, 'src', 'backend', 'services', 'security', `${name}.ts`);
  const result = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true, sourceMap: false },
  });
  if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) {
    throw new Error(`Cannot compile fixed smoke security module ${name}.`);
  }
  await fs.writeFile(path.join(destination, `${name}.cjs`), result.outputText);
}
