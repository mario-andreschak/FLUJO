/**
 * Recognise the most common reasons a local (stdio) MCP server fails to start,
 * from the error text the server printed, so the Test Run can name the real
 * cause and the right fix.
 *
 * Python and Node.js report missing files and missing packages differently:
 *
 * | Cause                    | What the user sees                                         |
 * |--------------------------|------------------------------------------------------------|
 * | Python script missing    | `python: can't open file '…/server.py': [Errno 2] …`       |
 * | Python package missing   | `ModuleNotFoundError: No module named 'fastmcp'`           |
 * | Node.js file missing     | `Error: Cannot find module '/…/index.js'` (MODULE_NOT_FOUND) |
 * | Node.js package missing  | `Error: Cannot find module 'express'` / `Cannot find package` |
 *
 * `MODULE_NOT_FOUND` is a Node.js error code; Python never prints it.
 *
 * Pure (no fs, no node `path`) so it runs in the browser-side Test Run.
 */

export type StartupFailureKind =
  | 'pythonScriptMissing'
  | 'pythonPackageMissing'
  | 'nodeFileMissing'
  | 'nodePackageMissing';

export interface StartupFailureHint {
  kind: StartupFailureKind;
  /** The file path or module/package name the runtime could not find. */
  target: string;
}

const PYTHON_SCRIPT_MISSING = /can't open file (['"])((?:\\.|(?!\1).)+)\1: \[Errno 2\]/;
const PYTHON_MODULE_MISSING = /ModuleNotFoundError: No module named (['"])([^'"\r\n]+)\1/;
const PYTHON_RUN_MODULE_MISSING = /^.*python[\w.]*(?:\.exe)?: No module named ([\w.]+)\s*$/im;
const NODE_NOT_FOUND = /Cannot find (module|package) '([^'\r\n]+)'/;

function unescapePythonRepr(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

function isPathSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(specifier) ||
    specifier.startsWith('file:')
  );
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function nodeHint(match: RegExpMatchArray): StartupFailureHint {
  const [, what, specifier] = match;
  if (what === 'package' || !isPathSpecifier(specifier)) {
    return { kind: 'nodePackageMissing', target: packageName(specifier) };
  }
  return { kind: 'nodeFileMissing', target: specifier };
}

/**
 * @returns the first recognised startup failure in `output`, or `null` when the
 *          text matches none of them (the caller then shows its generic message).
 */
export function findStartupFailureHint(output: string | null | undefined): StartupFailureHint | null {
  if (!output) return null;

  const script = output.match(PYTHON_SCRIPT_MISSING);
  if (script) return { kind: 'pythonScriptMissing', target: unescapePythonRepr(script[2]) };

  const pythonModule = output.match(PYTHON_MODULE_MISSING) ?? output.match(PYTHON_RUN_MODULE_MISSING);
  if (pythonModule) {
    return { kind: 'pythonPackageMissing', target: pythonModule[pythonModule.length - 1] };
  }

  const node = output.match(NODE_NOT_FOUND);
  if (node) return nodeHint(node);

  return null;
}
