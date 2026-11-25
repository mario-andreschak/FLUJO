// Zip a folder into an MCP bundle (.mcpb) for manual and browser checks (#1230):
//   node __tests__/mcp/fixtures/make-mcpb.mjs __tests__/mcp/fixtures/mcpb-hello <out>.mcpb
// Write the result outside the repository.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

async function addFolder(zip, root, folder = root) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) await addFolder(zip, root, full);
    else zip.file(path.relative(root, full).split(path.sep).join('/'), await readFile(full));
  }
}

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('Usage: node __tests__/mcp/fixtures/make-mcpb.mjs <folder with manifest.json> <out>.mcpb');
  process.exit(1);
}
const zip = new JSZip();
await addFolder(zip, path.resolve(source));
await mkdir(path.dirname(path.resolve(target)), { recursive: true });
await writeFile(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Wrote ${path.resolve(target)}`);
