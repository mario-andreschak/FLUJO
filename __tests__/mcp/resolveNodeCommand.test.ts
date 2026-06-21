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
  fileExists: (p) => existing.includes(p),
});

const winDeps = (existing: string[] = []): ResolveNodeCommandDeps => ({
  execPath: 'C:\\Program Files\\nodejs\\node.exe',
  platform: 'win32',
  dirname: (p) => p.slice(0, p.lastIndexOf('\\')),
  joinPath: (...parts) => parts.join('\\'),
  fileExists: (p) => existing.includes(p),
});

describe('resolveNodeCommand (#36)', () => {
  it('resolves bare `node` to process.execPath (nvm path)', () => {
    expect(resolveNodeCommand('node', posixDeps())).toBe(
      '/home/user/.nvm/versions/node/v20.11.0/bin/node'
    );
  });

  it('resolves bare `npx` to the sibling of the node binary (unix)', () => {
    const npx = '/home/user/.nvm/versions/node/v20.11.0/bin/npx';
    expect(resolveNodeCommand('npx', posixDeps([npx]))).toBe(npx);
  });

  it('resolves bare `npm` to the sibling of the node binary (unix)', () => {
    const npm = '/home/user/.nvm/versions/node/v20.11.0/bin/npm';
    expect(resolveNodeCommand('npm', posixDeps([npm]))).toBe(npm);
  });

  it('prefers the .cmd shim for npx on Windows', () => {
    const npxCmd = 'C:\\Program Files\\nodejs\\npx.cmd';
    expect(resolveNodeCommand('npx', winDeps([npxCmd]))).toBe(npxCmd);
  });

  it('resolves `node` to node.exe on Windows', () => {
    expect(resolveNodeCommand('node', winDeps())).toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('falls back to the bare command when no sibling npx exists', () => {
    // node resolves, but npx is not found next to it -> leave bare for PATH lookup.
    expect(resolveNodeCommand('npx', posixDeps([]))).toBe('npx');
  });

  it('leaves an explicit path command untouched', () => {
    expect(resolveNodeCommand('/usr/local/bin/node', posixDeps())).toBe('/usr/local/bin/node');
    expect(resolveNodeCommand('./dist/server.js', posixDeps())).toBe('./dist/server.js');
    expect(resolveNodeCommand('C:\\tools\\node.exe', winDeps())).toBe('C:\\tools\\node.exe');
  });

  it('leaves non-Node commands untouched', () => {
    expect(resolveNodeCommand('python', posixDeps())).toBe('python');
    expect(resolveNodeCommand('uvx', posixDeps())).toBe('uvx');
    expect(resolveNodeCommand('cmd.exe', winDeps())).toBe('cmd.exe');
    expect(resolveNodeCommand('', posixDeps())).toBe('');
  });

  it('is case-insensitive for the bin name but returns a real binary', () => {
    // Windows configs sometimes carry "Node"; still resolve it.
    expect(resolveNodeCommand('Node', winDeps())).toBe('C:\\Program Files\\nodejs\\node.exe');
  });
});
