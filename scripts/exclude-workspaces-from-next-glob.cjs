'use strict';

/**
 * Prevent Next's bundled glob implementation from descending into FLUJO's
 * runtime workspace data during production output tracing.
 *
 * Next 16 expands some dynamic runtime paths into project-wide globs before
 * outputFileTracingExcludes is applied. On Windows that traversal reaches
 * protected compatibility junctions (for example Content.IE5) and aborts the
 * build with EPERM. This preload prunes the workspaces subtree at traversal
 * time; next.config.mjs also excludes it from the final output traces.
 */
const path = require('node:path');
const Module = require('node:module');

const WORKSPACES_ROOT = path.resolve(process.cwd(), 'workspaces');
const PATCHED = Symbol.for('flujo.nextGlobWorkspacesExcluded');

function isInsideWorkspaces(candidate) {
  const relative = path.relative(WORKSPACES_ROOT, path.resolve(candidate));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function patchGlob(glob) {
  const prototype = glob?.Glob?.prototype;
  if (!prototype || prototype[PATCHED]) return;

  const originalReaddir = prototype._readdir;
  prototype._readdir = function excludeWorkspaceReaddir(candidate, inGlobStar, callback) {
    const absolute = typeof this._makeAbs === 'function'
      ? this._makeAbs(candidate)
      : path.resolve(this.cwd || process.cwd(), candidate);

    if (isInsideWorkspaces(absolute)) {
      if (this.cache) this.cache[absolute] = false;
      callback();
      return;
    }

    return originalReaddir.call(this, candidate, inGlobStar, callback);
  };

  Object.defineProperty(prototype, PATCHED, { value: true });
}

const originalLoad = Module._load;
Module._load = function loadWithWorkspaceExclusion(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (String(request).includes('next/dist/compiled/glob')) patchGlob(loaded);
  return loaded;
};
