import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builder-only equipment: actual production issuer and actual runtime imports.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const filename = path.join(root, 'src/backend/services/security/ownerCredentials.ts');
const source = await fs.readFile(filename, 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const compiled = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
if (compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error('Actual owner issuer compilation failed.');
const output = compiled.outputText;
await fs.writeFile(path.join(root, 'scripts/generated-smoke-owner-issuer.cjs'), output);
await fs.writeFile(path.join(root, 'scripts/generated-smoke-owner-issuer.json'), JSON.stringify({
  schemaVersion: 1, sourceSha256, compiledSha256: createHash('sha256').update(output).digest('hex'),
}));
console.log(`Compiled production owner issuer smoke equipment: ${sourceSha256}`);
