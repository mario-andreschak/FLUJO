const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
module.exports = async () => {
  const selectedRoot = process.env.FLUJO_APPEND_WITNESS_ROOT;
  if (!selectedRoot || !path.isAbsolute(selectedRoot)) throw new Error('Absolute diagnostic target root required');
  const root = fs.realpathSync(selectedRoot);
  if (root !== selectedRoot) throw new Error('Canonical diagnostic target root required');
  const application = await import(pathToFileURL(path.join(root, 'jest.config.mjs')).href);
  const config = await application.default();
  const node = config.projects.find(project => project.displayName === 'node' || project.displayName?.name === 'node');
  if (!node) throw new Error('Owned Node project not found');
  // This config lives outside append-target. Anchor both levels explicitly.
  node.rootDir = root;
  node.setupFiles = [...(node.setupFiles ?? []), path.join(__dirname, 'retain-data-root.cjs')];
  const entry = Object.entries(node.transform).find(([pattern]) => pattern.includes('tsx'));
  if (!entry || !Array.isArray(entry[1])) throw new Error('Expected owned Next/SWC transformer options');
  const targets = ['src/backend/services/workspace/workspaceMutationGate.ts', 'src/backend/services/enduringAgents/runtimeLock.ts', 'src/backend/services/enduringAgents/runtimeEvents.ts', 'src/backend/services/enduringAgents/store.ts', 'src/backend/services/enduringAgents/personaRecoveryOrigins.ts', 'src/utils/storage/backend.ts'];
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const observed = Object.fromEntries(targets.map(relative => [String.raw`[/\\]` + relative.split('/').map(escape).join(String.raw`[/\\]`) + '$', [path.join(__dirname, 'transform.cjs'), entry[1][1]]]));
  node.transform = { ...observed, ...node.transform };
  return { rootDir: root, projects: [node] };
};
