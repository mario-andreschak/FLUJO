'use strict';

/**
 * Prevent Next's dependency tracer from descending into runtime workspace data.
 *
 * Next 16 expands some dynamic runtime paths into project-wide globs before
 * outputFileTracingExcludes is applied. On Windows that traversal reaches
 * protected junctions or exhausts the heap in populated installations. Current
 * Next bundles glob inside @vercel/nft, so patching compiled/glob's prototype
 * does not reach that traversal. Give only those two bundled modules a pruned
 * filesystem view. Application code and other build tools keep the real fs.
 * next.config.mjs also excludes workspaces from the final output traces.
 */
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');

const WORKSPACES_ROOT = path.resolve(process.cwd(), 'workspaces');
const TRACE_MODULES = new Set([
  require.resolve('next/dist/compiled/@vercel/nft'),
  require.resolve('next/dist/compiled/glob'),
]);

function directoryPath(candidate) {
  return candidate instanceof URL ? fileURLToPath(candidate) : String(candidate);
}

function isInsideWorkspaces(candidate) {
  const relative = path.relative(WORKSPACES_ROOT, path.resolve(directoryPath(candidate)));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function withoutWorkspaces(candidate, entries) {
  return entries.filter((entry) => {
    const name = typeof entry === 'string' || Buffer.isBuffer(entry) ? entry : entry.name;
    return !isInsideWorkspaces(path.join(directoryPath(candidate), String(name)));
  });
}

const tracingFs = {
  ...fs,
  readdir(candidate, ...args) {
    const callback = args.pop();
    if (isInsideWorkspaces(candidate)) {
      queueMicrotask(() => callback(null, []));
      return;
    }
    return fs.readdir(candidate, ...args, (error, entries) => {
      callback(error, error ? entries : withoutWorkspaces(candidate, entries));
    });
  },
  readdirSync(candidate, ...args) {
    return isInsideWorkspaces(candidate) ? [] : withoutWorkspaces(candidate, fs.readdirSync(candidate, ...args));
  },
  promises: {
    ...fs.promises,
    async readdir(candidate, ...args) {
      return isInsideWorkspaces(candidate) ? [] : withoutWorkspaces(candidate, await fs.promises.readdir(candidate, ...args));
    },
  },
};

const originalLoad = Module._load;
Module._load = function loadWithWorkspaceExclusion(request, parent, isMain) {
  if (TRACE_MODULES.has(parent?.filename)) {
    if (request === 'fs' || request === 'node:fs') return tracingFs;
    if (request === 'fs/promises' || request === 'node:fs/promises') return tracingFs.promises;
  }
  return originalLoad.call(this, request, parent, isMain);
};
