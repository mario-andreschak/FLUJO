import { resolveNodeCommand, ResolveNodeCommandDeps } from '@/utils/mcp/resolveNodeCommand';

// Issue #36: `spawn node ENOENT` when FLUJO is launched outside a shell that
// initialized nvm, so the inherited PATH lacks the nvm Node bin dir. Resolving
// bare `node`/`npm`/`npx` to absolute paths derived from process.execPath fixes it.

// Minimal path helpers so the tests don't depend on the host OS path module.
const posixDeps = (existing: string[] = []): ResolveNodeCommandDeps => ({
  execPath: '/home/user/.nvm/versions/node/v20.11.0/bin/node',
  platform: 'linux',
  dirname: (p) => p.slice(0, p.lastIndexOf('/')),
  joinPath: (...parts) => parts.join('/'),
  fileExists: async (p) => existing.includes(p),
});

const winDeps = (existing: string[] = []): ResolveNodeCommandDeps => ({
  execPath: 'C:\\Program Files\\nodejs\\node.exe',
  platform: 'win32',
  dirname: (p) => p.slice(0, p.lastIndexOf('\\')),
  joinPath: (...parts) => parts.join('\\'),
  fileExists: async (p) => existing.includes(p),
});

describe('resolveNodeCommand (#36)', () => {
  it('resolves bare `node` to process.execPath (nvm path)', async () => {
    await expect(resolveNodeCommand('node', posixDeps())).resolves.toBe(
      '/home/user/.nvm/versions/node/v20.11.0/bin/node'
    );
  });

  it('resolves bare `npx` to the sibling of the node binary (unix)', async () => {
    const npx = '/home/user/.nvm/versions/node/v20.11.0/bin/npx';
    await expect(resolveNodeCommand('npx', posixDeps([npx]))).resolves.toBe(npx);
  });

  it('resolves bare `npm` to the sibling of the node binary (unix)', async () => {
    const npm = '/home/user/.nvm/versions/node/v20.11.0/bin/npm';
    await expect(resolveNodeCommand('npm', posixDeps([npm]))).resolves.toBe(npm);
  });

  it('prefers the .cmd shim for npx on Windows', async () => {
    const npxCmd = 'C:\\Program Files\\nodejs\\npx.cmd';
    await expect(resolveNodeCommand('npx', winDeps([npxCmd]))).resolves.toBe(npxCmd);
  });

  it('resolves `node` to node.exe on Windows', async () => {
    await expect(resolveNodeCommand('node', winDeps())).resolves.toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('falls back to the bare command when no sibling npx exists', async () => {
    // node resolves, but npx is not found next to it -> leave bare for PATH lookup.
    await expect(resolveNodeCommand('npx', posixDeps([]))).resolves.toBe('npx');
  });

  it('leaves an explicit path command untouched', async () => {
    await expect(resolveNodeCommand('/usr/local/bin/node', posixDeps())).resolves.toBe('/usr/local/bin/node');
    await expect(resolveNodeCommand('./dist/server.js', posixDeps())).resolves.toBe('./dist/server.js');
    await expect(resolveNodeCommand('C:\\tools\\node.exe', winDeps())).resolves.toBe('C:\\tools\\node.exe');
  });

  it('leaves non-Node commands untouched', async () => {
    await expect(resolveNodeCommand('python', posixDeps())).resolves.toBe('python');
    await expect(resolveNodeCommand('uvx', posixDeps())).resolves.toBe('uvx');
    await expect(resolveNodeCommand('cmd.exe', winDeps())).resolves.toBe('cmd.exe');
    await expect(resolveNodeCommand('', posixDeps())).resolves.toBe('');
  });

  it('is case-insensitive for the bin name but returns a real binary', async () => {
    // Windows configs sometimes carry "Node"; still resolve it.
    await expect(resolveNodeCommand('Node', winDeps())).resolves.toBe('C:\\Program Files\\nodejs\\node.exe');
  });
});
