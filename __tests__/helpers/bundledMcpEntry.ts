import fs from 'node:fs';
import path from 'node:path';

const { formatUnbuiltMcpMessage } = require('../../scripts/bundled-mcp-build.cjs') as {
  formatUnbuiltMcpMessage(names: string[], root: string): string;
};

/** The built entry of a bundled MCP package in this checkout. A missing build names the package and the fix. */
export function bundledMcpEntry(name: string, root = process.cwd()): string {
  const entry = path.resolve(root, 'mcp-servers', name, 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(formatUnbuiltMcpMessage([name], root));
  return entry;
}
