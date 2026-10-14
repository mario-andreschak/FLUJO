// Disposable equipment loaded only by the explicitly owned acceptance child.
// It changes real Node filesystem operations, never the compiled application.
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FLUJO_ACCEPTANCE_MIGRATION_ROOT;
const mode = process.env.FLUJO_ACCEPTANCE_MIGRATION_FAULT;
if (root && mode) {
  if (!path.isAbsolute(root) || path.resolve(root) !== path.resolve(process.env.FLUJO_DATA_DIR || '')) {
    throw new Error('Migration fault equipment requires its exact private data root.');
  }
  if (!['enospc-artifacts', 'hold-after-screenshots', 'enospc-snapshot'].includes(mode)) {
    throw new Error('Unknown migration acceptance fault.');
  }
  const inside = file => {
    const relative = path.relative(root, String(file));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const noSpace = () => Object.assign(new Error('Disposable migration disk-full injection'), { code: 'ENOSPC' });
  const witness = (phase, bytesWritten = 0) => process.send?.({ type: 'migration-fault-observed', phase, bytesWritten });
  const rename = fs.promises.rename.bind(fs.promises);
  fs.promises.rename = async (from, to) => {
    if (inside(from) && inside(to)) {
      const relative = path.relative(root, String(from));
      if (mode === 'enospc-artifacts' && (relative === 'artifacts' || relative.startsWith(`artifacts${path.sep}`))) {
        witness('artifacts-rename-enospc');
        throw noSpace();
      }
      if (mode === 'hold-after-screenshots' && relative === 'screenshots') {
        await rename(from, to);
        witness('screenshots-rename-completed');
        await new Promise(() => {}); // Parent must observe and kill this original child.
        return;
      }
    }
    return rename(from, to);
  };
  if (mode === 'enospc-snapshot') {
    const open = fs.promises.open.bind(fs.promises);
    fs.promises.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      const relative = inside(file) && path.relative(root, String(file));
      if (relative && /^workspaces[\\/]\.worker-restore-[^\\/]+[\\/]userdata[\\/]proof\.txt$/.test(relative)) {
        const write = handle.write.bind(handle);
        let admitted = false;
        handle.write = async (buffer, offset, length, position) => {
          if (!admitted) {
            admitted = true;
            const result = await write(buffer, offset, Math.min(length, 4096), position);
            witness('snapshot-partial-write', result.bytesWritten);
            return result;
          }
          witness('snapshot-write-enospc');
          throw noSpace();
        };
      }
      return handle;
    };
  }
}
