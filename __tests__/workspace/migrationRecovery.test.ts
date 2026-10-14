import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _resetWorkspaceMigrationState, _workspaceMigrationPathsForTests, migrateWorkspaceLayout,
} from '@/backend/services/workspace/migration';
import { getWorkspaceLayoutStatus, waitForWorkspaceLayoutReady } from '@/backend/services/workspace/layoutReadiness';

describe('interrupted workspace migration recovery', () => {
  let root: string;
  const keys = ['FLUJO_DATA_DIR', 'FLUJO_APP_ROOT', 'FLUJO_WORKER_MODE'] as const;
  let previous: Array<string | undefined>;
  const data = () => path.join(root, 'data');
  const workspace = () => path.join(data(), 'workspaces', 'default-workspace');
  const write = async (relative: string, text: string) => {
    const file = path.join(data(), relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  };
  const noSpace = () => Object.assign(new Error('Injected disk full'), { code: 'ENOSPC' });
  const faultRename = (destination: string) => {
    const rename = fs.rename.bind(fs);
    return jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === destination) throw noSpace();
      return rename(from, to);
    });
  };
  const linkedTree = async (subtree = 'userdata') => {
    const payload = await write(`${subtree}/packages/shared/value.txt`, 'retained-payload');
    const source = path.join(data(), subtree, 'dependency');
    await fs.symlink(path.dirname(payload), source, process.platform === 'win32' ? 'junction' : 'dir');
    return { payload, source, destination: path.join(workspace(), subtree, 'dependency'),
      target: path.join(workspace(), subtree, 'packages', 'shared') };
  };

  beforeEach(async () => {
    previous = keys.map(key => process.env[key]);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-migration-recovery-'));
    process.env.FLUJO_DATA_DIR = data();
    process.env.FLUJO_APP_ROOT = path.join(root, 'application');
    delete process.env.FLUJO_WORKER_MODE;
    _resetWorkspaceMigrationState();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    _resetWorkspaceMigrationState();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('retains both collision files and refuses readiness when rename hits ENOSPC', async () => {
    const source = await write('userdata/same.txt', 'legacy-wins');
    const target = await write('workspaces/default-workspace/userdata/same.txt', 'old-target');
    const fault = faultRename(target);
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_INCOMPLETE' });
    expect(getWorkspaceLayoutStatus()).toBe('failed');
    await expect(waitForWorkspaceLayoutReady()).rejects.toThrow();
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('legacy-wins');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('old-target');
    await expect(fs.lstat(_workspaceMigrationPathsForTests().marker)).rejects.toMatchObject({ code: 'ENOENT' });
    fault.mockRestore();
    _resetWorkspaceMigrationState();
    await migrateWorkspaceLayout();
    expect(getWorkspaceLayoutStatus()).toBe('ready');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('legacy-wins');
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves incompatible file/directory collision payloads for an operator decision', async () => {
    const source = await write('userdata/same', 'legacy-file');
    const nested = await write('workspaces/default-workspace/userdata/same/retained.txt', 'destination-tree');
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_INCOMPLETE' });
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('legacy-file');
    await expect(fs.readFile(nested, 'utf8')).resolves.toBe('destination-tree');
  });

  it('preserves the previous marker when atomic publication hits ENOSPC', async () => {
    await migrateWorkspaceLayout();
    const marker = _workspaceMigrationPathsForTests().marker;
    const previousMarker = await fs.readFile(marker);
    const target = path.join(workspace(), 'userdata', 'later.txt');
    await write('userdata/later.txt', 'later');
    _resetWorkspaceMigrationState();
    const fault = faultRename(marker);
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(fs.readFile(marker)).resolves.toEqual(previousMarker);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('later');
    fault.mockRestore();
    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).resolves.toBeDefined();
  });

  it('refuses the existing-marker fast path when legacy source inspection fails', async () => {
    await migrateWorkspaceLayout();
    _resetWorkspaceMigrationState();
    const lstat = fs.lstat.bind(fs);
    const fault = jest.spyOn(fs, 'lstat').mockImplementation(((file, options) => {
      if (String(file) === path.join(data(), 'userdata')) return Promise.reject(noSpace());
      return lstat(file, options);
    }) as typeof fs.lstat);
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_INCOMPLETE' });
    expect(getWorkspaceLayoutStatus()).toBe('failed');
    fault.mockRestore();
  });

  it('leaves original links untouched if persisting recovery fails before moves', async () => {
    const linked = await linkedTree();
    const before = await fs.readlink(linked.source);
    faultRename(_workspaceMigrationPathsForTests().links);
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(fs.readlink(linked.source)).resolves.toBe(before);
    await expect(fs.readFile(linked.payload, 'utf8')).resolves.toBe('retained-payload');
  });

  it('recovers a missing junction after unlink/recreate interruption with no legacy source left', async () => {
    const linked = await linkedTree();
    const symlink = fs.symlink.bind(fs);
    const fault = jest.spyOn(fs, 'symlink').mockImplementation(async (target, link, type) => {
      if (String(link) === linked.destination) throw noSpace();
      return symlink(target, link, type);
    });
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_INCOMPLETE' });
    await expect(fs.lstat(linked.source)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(linked.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    const journal = _workspaceMigrationPathsForTests().links;
    expect(JSON.parse(await fs.readFile(journal, 'utf8')).links).toHaveLength(1);
    fault.mockRestore();
    _resetWorkspaceMigrationState();
    await migrateWorkspaceLayout();
    expect((await fs.realpath(linked.destination)).toLowerCase()).toBe((await fs.realpath(linked.target)).toLowerCase());
    await expect(fs.readFile(path.join(linked.target, 'value.txt'), 'utf8')).resolves.toBe('retained-payload');
    await expect(fs.lstat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites an unrelated replacement while replaying the link receipt', async () => {
    const linked = await linkedTree();
    const symlink = fs.symlink.bind(fs);
    const fault = jest.spyOn(fs, 'symlink').mockImplementation(async (target, link, type) => {
      if (String(link) === linked.destination) throw noSpace();
      return symlink(target, link, type);
    });
    await expect(migrateWorkspaceLayout()).rejects.toThrow();
    fault.mockRestore();
    await fs.writeFile(linked.destination, 'unrelated-replacement');
    _resetWorkspaceMigrationState();
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_INCOMPLETE' });
    await expect(fs.readFile(linked.destination, 'utf8')).resolves.toBe('unrelated-replacement');
    await expect(fs.lstat(_workspaceMigrationPathsForTests().links)).resolves.toBeDefined();
  });

  it('replays already remapped links after marker failure without scanning moved payloads', async () => {
    const linked = await linkedTree();
    const fault = faultRename(_workspaceMigrationPathsForTests().marker);
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'ENOSPC' });
    fault.mockRestore();
    _resetWorkspaceMigrationState();
    const readdir = jest.spyOn(fs, 'readdir');
    await migrateWorkspaceLayout();
    expect(readdir.mock.calls.map(([file]) => String(file))).not.toContain(path.join(workspace(), 'userdata'));
    expect((await fs.realpath(linked.destination)).toLowerCase()).toBe((await fs.realpath(linked.target)).toLowerCase());
    await expect(fs.lstat(_workspaceMigrationPathsForTests().links)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves obsolete migration staging payload and its old journals', async () => {
    const paths = _workspaceMigrationPathsForTests();
    const payload = path.join(paths.transactions, 'old', 'stage', 'only-copy.txt');
    await fs.mkdir(path.dirname(payload), { recursive: true });
    await fs.writeFile(payload, 'only-copy');
    await fs.writeFile(paths.journal, 'original-journal');
    await expect(migrateWorkspaceLayout()).rejects.toThrow('staging contains data');
    await expect(fs.readFile(payload, 'utf8')).resolves.toBe('only-copy');
    await expect(fs.readFile(paths.journal, 'utf8')).resolves.toBe('original-journal');
  });

  it('rejects an unsafe recovery record before touching payload data', async () => {
    const source = await write('userdata/retained.txt', 'retained');
    await write('workspaces/.workspace-layout.links.json', JSON.stringify({ version: 1, links: [
      { source, destination: path.join(root, 'outside'), originalTarget: 'outside', target: 'outside',
        directory: false, dev: '1', ino: '1' },
    ] }));
    await expect(migrateWorkspaceLayout()).rejects.toThrow('unsafe entry');
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('retained');
  });

  it('preserves links when target inspection is unavailable', async () => {
    const linked = await linkedTree();
    const before = await fs.readlink(linked.source);
    const stat = fs.stat.bind(fs);
    jest.spyOn(fs, 'stat').mockImplementation(((file, options) => {
      if (String(file) === linked.source) return Promise.reject(Object.assign(new Error('Denied target inspection'), { code: 'EACCES' }));
      return stat(file, options);
    }) as typeof fs.stat);
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_INCOMPLETE' });
    await expect(fs.readlink(linked.source)).resolves.toBe(before);
    await expect(fs.readFile(linked.payload, 'utf8')).resolves.toBe('retained-payload');
  });

  (process.platform === 'win32' ? it : it.skip)('retains an unknown dangling Windows junction before any move', async () => {
    const source = path.join(data(), 'userdata', 'dangling');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.symlink(path.join(data(), 'userdata', 'missing-target'), source, 'junction');
    const before = await fs.readlink(source);
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_INCOMPLETE' });
    await expect(fs.readlink(source)).resolves.toBe(before);
    await expect(fs.lstat(_workspaceMigrationPathsForTests().links)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a custom MCP parent link attached to the shared application container', async () => {
    process.env.FLUJO_APP_ROOT = data();
    await write('mcp-servers/bash/bundled.txt', 'bundled');
    await write('mcp-servers/custom-server/index.js', 'custom');
    const source = path.join(data(), 'mcp-servers', 'custom-server', 'parent');
    const container = path.dirname(path.dirname(source));
    await fs.symlink(container, source, process.platform === 'win32' ? 'junction' : 'dir');
    await migrateWorkspaceLayout();
    const moved = path.join(workspace(), 'mcp-servers', 'custom-server', 'parent');
    expect((await fs.realpath(moved)).toLowerCase()).toBe((await fs.realpath(container)).toLowerCase());
    await expect(fs.readFile(path.join(moved, 'bash', 'bundled.txt'), 'utf8')).resolves.toBe('bundled');
  });

  it('replays a custom MCP receipt after its legacy entry disappeared in a shared root', async () => {
    process.env.FLUJO_APP_ROOT = data();
    await write('mcp-servers/bash/bundled.txt', 'bundled');
    const linked = await linkedTree('mcp-servers/custom-server');
    const symlink = fs.symlink.bind(fs);
    const fault = jest.spyOn(fs, 'symlink').mockImplementation(async (target, link, type) => {
      if (String(link) === linked.destination) throw noSpace();
      return symlink(target, link, type);
    });
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_INCOMPLETE' });
    fault.mockRestore();
    _resetWorkspaceMigrationState();
    await migrateWorkspaceLayout();
    expect((await fs.realpath(linked.destination)).toLowerCase()).toBe((await fs.realpath(linked.target)).toLowerCase());
    await expect(fs.readFile(path.join(data(), 'mcp-servers/bash/bundled.txt'), 'utf8')).resolves.toBe('bundled');
  });

  it('recovers a recorded junction whose target subtree moved before its own subtree failed', async () => {
    const payload = await write('userdata/packages/shared/value.txt', 'cross-subtree');
    const source = path.join(data(), 'artifacts', 'dependency');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.symlink(path.dirname(payload), source, process.platform === 'win32' ? 'junction' : 'dir');
    const rename = fs.rename.bind(fs);
    const fault = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(data(), 'artifacts') || String(from).startsWith(path.join(data(), 'artifacts') + path.sep)) throw noSpace();
      return rename(from, to);
    });
    await expect(migrateWorkspaceLayout()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_INCOMPLETE' });
    await expect(fs.lstat(path.join(data(), 'userdata'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(source)).resolves.toBeDefined();
    expect(JSON.parse(await fs.readFile(_workspaceMigrationPathsForTests().links, 'utf8')).links[0].directory).toBe(true);
    fault.mockRestore();
    _resetWorkspaceMigrationState();
    await migrateWorkspaceLayout();
    await expect(fs.readFile(path.join(workspace(), 'artifacts/dependency/value.txt'), 'utf8')).resolves.toBe('cross-subtree');
    await expect(fs.lstat(_workspaceMigrationPathsForTests().links)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  (process.platform !== 'win32' ? it : it.skip)('keeps a POSIX self-parent link as a direct move without a remap record', async () => {
    const payload = await write('userdata/repository/value.txt', 'self-parent');
    const source = path.join(path.dirname(payload), 'self');
    await fs.symlink('.', source, 'dir');
    const before = await fs.lstat(source, { bigint: true });
    await migrateWorkspaceLayout();
    const target = path.join(workspace(), 'userdata/repository/self');
    const after = await fs.lstat(target, { bigint: true });
    expect(await fs.readlink(target)).toBe('.');
    expect(after.dev).toBe(before.dev); expect(after.ino).toBe(before.ino);
    await expect(fs.readFile(path.join(target, 'value.txt'), 'utf8')).resolves.toBe('self-parent');
    await expect(fs.lstat(_workspaceMigrationPathsForTests().links)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
