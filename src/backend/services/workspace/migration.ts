import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { constants as fsConstants, type BigIntStats, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { getAppDir, getDataDir } from '@/utils/paths';
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_SUBTREES,
  ensureWorkspaceDirs,
  getWorkspaceDir,
  getWorkspacesDir,
} from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import {
  failWorkspaceLayoutPreparation,
  getWorkspaceLayoutPreparation,
  setWorkspaceLayoutPreparation,
} from './layoutReadiness';
import { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';
import {
  reportWorkspaceMigration as migrationConsole,
  resetWorkspaceMigrationProgress,
} from './migrationProgress';

export { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';

const log = createLogger('backend/services/workspace/migration');

const MARKER_FILE = '.workspace-layout.json';
const JOURNAL_FILE = '.workspace-layout.transaction.json';
const FAST_JOURNAL_FILE = '.workspace-layout.fast-transaction.json';
const LOCK_DIR = '.workspace-layout.lock';
const TRANSACTIONS_DIR = '.workspace-migrations';
const OWNER_FILE = 'owner.json';
const HEARTBEAT_FILE = 'heartbeat';
const JOURNAL_SCHEMA_VERSION = 4;
const LEGACY_JOURNAL_SCHEMA_VERSION = 3;
const SUPPORTED_JOURNAL_SCHEMA_VERSIONS = new Set([
  LEGACY_JOURNAL_SCHEMA_VERSION,
  JOURNAL_SCHEMA_VERSION,
]);
const FAST_JOURNAL_SCHEMA_VERSION = 3;
const LEGACY_FAST_JOURNAL_SCHEMA_VERSION = 2;
const SUPPORTED_FAST_JOURNAL_SCHEMA_VERSIONS = new Set([
  LEGACY_FAST_JOURNAL_SCHEMA_VERSION,
  FAST_JOURNAL_SCHEMA_VERSION,
]);
const LOCK_HEARTBEAT_MS = 30_000;
const LOCK_LEASE_MS = 5 * 60_000;
const METADATA_RENAME_ATTEMPTS = 8;
const MAX_RECONCILIATION_PASSES = 8;
const MIGRATION_PROGRESS_INTERVAL_MS = 5_000;
const FAST_INVENTORY_LEAF_CONCURRENCY = 32;
const WINDOWS_MOVE_HELPER_START_TIMEOUT_MS = 30_000;
const WINDOWS_MOVE_HELPER_REQUEST_TIMEOUT_MS = 60_000;
const WINDOWS_MOVE_HELPER_IDLE_MS = 5_000;
const FAST_WORKSPACE_MCP_ID = '__workspace-mcp-root';

function formatMigrationBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1_024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1_024; index += 1) {
    value /= 1_024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatMigrationDuration(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1_000).toFixed(1)}s`;
}

/** These are application source/runtime packages, not workspace-installed MCPs. */
const APP_OWNED_MCP_ENTRIES = new Set([
  'readme.md',
  'embed-shared.mjs',
  'bash',
  'browser',
  'filesystem',
  'flujo',
  'shared',
]);
const TRANSACTION_BACKUP_NAME = /^\..+\.workspace-v2-[0-9a-f-]+(?:\.destination)?\.bak$/i;
const FAST_LINK_ARTIFACT_NAME = /^\.flujo-workspace-[0-9a-f]{8}-[0-9a-f]{16}\.(?:new|old)$/i;

const LEGACY_DB_CANDIDATES = [
  ['db'],
  ['.next', 'storage'],
  ['storage'],
] as const;

const EXTRA_WORKSPACE_ROOTS = [
  'userdata',
  'snapshots',
  'screenshots',
  'recordings',
  'browser-profile',
  'bash-utils',
  'artifacts',
] as const;

export interface WorkspaceLayoutMarker {
  version: number;
  completedAt: string;
  defaultWorkspace: string;
  subtrees: Record<string, SubtreeOutcome>;
  transactionId?: string;
  manifestDigest?: string;
}

export type SubtreeOutcome =
  | 'created'
  | 'moved'
  | 'copied'
  | 'already-migrated'
  | 'recovered-identical'
  | 'reconciled'
  | 'skipped';

const SUBTREE_OUTCOMES = new Set<SubtreeOutcome>([
  'created',
  'moved',
  'copied',
  'already-migrated',
  'recovered-identical',
  'reconciled',
  'skipped',
]);
const JOURNAL_STATES = new Set<JournalEntry['state']>([
  'planned',
  'staged',
  'sources-archived',
  'destination-archived',
  'published',
]);
const JOURNAL_PHASES = new Set<MigrationJournal['phase']>([
  'planned',
  'staging',
  'committing',
  'marker',
  'cleanup',
  'committed',
]);
const FAST_JOURNAL_PHASES = new Set<FastMigrationJournal['phase']>([
  'planned',
  'applying',
  'marker',
  'cleanup',
  'committed',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type ManifestEntry = {
  relativePath: string;
  type: 'directory' | 'file' | 'symlink';
  /** Portable permission bits. File type bits are represented by `type`. */
  mode?: number;
  size?: number;
  sha256?: string;
  /** File access time is preserved but intentionally excluded from content identity. */
  atimeMs?: number;
  /** File modification time is preserved but not treated as content identity. */
  mtimeMs?: number;
  linkTarget?: string;
  linkType?: 'file' | 'directory' | 'junction';
};

type PathManifest = {
  entries: ManifestEntry[];
  digest: string;
  emptyDirectory: boolean;
  /** Links whose raw target still names an explicitly supplied pre-relocation root. */
  relocatedLinks: number;
  relocatedLinkPaths: string[];
  absoluteLinkPaths: string[];
  /** Files with another hard-link name, possibly outside the managed root. */
  hardLinkedFilePaths: string[];
};

type JournalSource = {
  path: string;
  backup: string;
  initialDigest?: string;
  retainedMount?: boolean;
  /** Preflight inventory used for idempotent, post-marker mount cleanup. */
  retainedEntries?: ManifestEntry[];
  /** Durable deletion intent: a partial recursive delete is safe to resume. */
  cleanupStarted?: boolean;
};

type JournalEntry = {
  id: string;
  subtree: string;
  sources: JournalSource[];
  destination: string;
  destinationBackup: string;
  initialDestinationDigest?: string;
  /** Existing destination links that must be republished with workspace-local targets. */
  destinationLinksToRelocate?: number;
  /** Rebuild an already-current destination to sever hard links outside it. */
  forceRepublish?: boolean;
  stage: string;
  expectedDigest: string;
  /** Durable merged metadata; recovery must not rediscover timestamps after a crash. */
  expectedEntries: ManifestEntry[];
  state: 'planned' | 'staged' | 'sources-archived' | 'destination-archived' | 'published';
  outcome: SubtreeOutcome;
  requireDirectory: boolean;
  /** Durable deletion intents for transaction-owned post-marker artifacts. */
  destinationBackupCleanupStarted?: boolean;
  stageCleanupStarted?: boolean;
};

type MigrationJournal = {
  schemaVersion: number;
  targetVersion: number;
  transactionId: string;
  createdAt: string;
  phase: 'planned' | 'staging' | 'committing' | 'marker' | 'cleanup' | 'committed';
  entries: JournalEntry[];
};

type FastRootIdentity = {
  /** Decimal strings preserve Windows file IDs beyond Number.MAX_SAFE_INTEGER. */
  dev: string;
  ino: string;
  birthtimeNs: string;
};

type FastLinkPlan = {
  relativePath: string;
  oldTarget: string;
  newTarget: string;
  linkType: 'directory' | 'junction';
  linkIdentity: FastRootIdentity;
  parentIdentity: FastRootIdentity;
};

type FastJournalEntry = {
  id: string;
  subtree: string;
  action: 'current' | 'move';
  sourceIndex?: number;
  sourceIdentity?: FastRootIdentity;
  sourceParentIdentity?: FastRootIdentity;
  destinationIdentity?: FastRootIdentity;
  destinationParentIdentity: FastRootIdentity;
  structuralDigest?: string;
  links: FastLinkPlan[];
  outcome: SubtreeOutcome;
};

type FastMigrationJournal = {
  schemaVersion: number;
  targetVersion: number;
  transactionId: string;
  createdAt: string;
  phase: 'planned' | 'applying' | 'marker' | 'cleanup' | 'committed';
  entries: FastJournalEntry[];
};

type CandidateEntry = {
  id: string;
  subtree: string;
  sources: string[];
  destination: string;
  requireDirectory: boolean;
};

type LockOwner = {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
};

export class WorkspaceMigrationConflictError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_CONFLICT';

  constructor(subtree: string, source: string, destination: string, detail?: string) {
    super(
      `Cannot migrate "${subtree}" into the default workspace because managed ` +
        `copies disagree.\n  legacy:    ${source}\n  workspace: ${destination}\n` +
        `${detail ? `  detail:     ${detail}\n` : ''}` +
        `FLUJO did not overwrite either copy. Back up both locations and resolve ` +
        `the conflicting path before retrying.`,
    );
    this.name = 'WorkspaceMigrationConflictError';
  }
}

export class WorkspaceMigrationMarkerError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_MARKER_INVALID';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceMigrationMarkerError';
  }
}

export class WorkspaceMigrationLockedError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_LOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceMigrationLockedError';
  }
}

export class WorkspaceMigrationUnsafePathError extends Error {
  readonly code = 'WORKSPACE_MIGRATION_UNSAFE_PATH';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceMigrationUnsafePathError';
  }
}

type FaultHook = (checkpoint: string) => void | Promise<void>;
type MoveFaultHook = (
  source: string,
  destination: string,
  kind: NoReplaceMoveKind,
) => void | Promise<void>;
let faultHook: FaultHook | undefined;
let fastFaultHook: FaultHook | undefined;
let moveFaultHook: MoveFaultHook | undefined;
let lockHeartbeatIntervalMs = LOCK_HEARTBEAT_MS;
let mountInfoForTests: string | undefined;

/** Test-only fault injection seam. FLUJO_DATA_DIR must point at a temp fixture. */
export function _setWorkspaceMigrationFaultForTests(hook?: FaultHook): void {
  faultHook = hook;
}

/** Test-only fault injection for the metadata-only atomic transaction. */
export function _setWorkspaceMigrationFastFaultForTests(hook?: FaultHook): void {
  fastFaultHook = hook;
}

/** Test-only native-move fault injection; never set this outside a temp fixture. */
export function _setWorkspaceMigrationMoveFaultForTests(hook?: MoveFaultHook): void {
  moveFaultHook = hook;
}

export function _setWorkspaceMigrationHeartbeatMsForTests(value?: number): void {
  lockHeartbeatIntervalMs = value ?? LOCK_HEARTBEAT_MS;
}

/** Test-only Linux mount-table injection; avoids requiring mount privileges. */
export function _setWorkspaceMigrationMountInfoForTests(value?: string): void {
  mountInfoForTests = value;
}

export function _resetWorkspaceMigrationState(): void {
  setWorkspaceLayoutPreparation(undefined);
  resetWorkspaceMigrationProgress();
  faultHook = undefined;
  fastFaultHook = undefined;
  moveFaultHook = undefined;
  lockHeartbeatIntervalMs = LOCK_HEARTBEAT_MS;
  mountInfoForTests = undefined;
}

export function _workspaceMigrationPathsForTests(): {
  marker: string;
  journal: string;
  fastJournal: string;
  lock: string;
  transactions: string;
} {
  return {
    marker: markerPath(),
    journal: journalPath(),
    fastJournal: fastJournalPath(),
    lock: lockPath(),
    transactions: transactionsPath(),
  };
}

async function checkpoint(name: string): Promise<void> {
  await faultHook?.(name);
}

async function fastCheckpoint(name: string): Promise<void> {
  await fastFaultHook?.(name);
}

export function migrateWorkspaceLayout(): Promise<WorkspaceLayoutMarker> {
  const existing = getWorkspaceLayoutPreparation<WorkspaceLayoutMarker>();
  if (existing) return existing;
  const startedAt = Date.now();
  migrationConsole('started', {
    version: WORKSPACE_LAYOUT_VERSION,
    pid: process.pid,
    dataRoot: getDataDir(),
    workspaceRoot: getWorkspaceDir(DEFAULT_WORKSPACE),
  });
  const promise = runMigration().catch(error => {
    migrationConsole('FAILED - no conflicting data was overwritten', {
      elapsed: formatMigrationDuration(startedAt),
      code: error instanceof Error && 'code' in error
        ? String((error as Error & { code?: unknown }).code)
        : undefined,
      error: error instanceof Error ? error.message : String(error),
    }, 'error');
    failWorkspaceLayoutPreparation(promise, error);
    throw error;
  });
  void promise.then(marker => migrationConsole('finished successfully', {
    elapsed: formatMigrationDuration(startedAt),
    transactionId: marker.transactionId,
    workspaceRoot: getWorkspaceDir(DEFAULT_WORKSPACE),
  }), () => undefined);
  setWorkspaceLayoutPreparation(promise);
  return promise;
}

export const ensureWorkspaceLayoutReady = migrateWorkspaceLayout;

function markerPath(): string {
  return path.join(getWorkspacesDir(), MARKER_FILE);
}

function journalPath(): string {
  return path.join(getWorkspacesDir(), JOURNAL_FILE);
}

function fastJournalPath(): string {
  return path.join(getWorkspacesDir(), FAST_JOURNAL_FILE);
}

function lockPath(): string {
  return path.join(getWorkspacesDir(), LOCK_DIR);
}

function transactionsPath(): string {
  return path.join(getWorkspacesDir(), TRANSACTIONS_DIR);
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function manifestPathIdentity(relativePath: string): string {
  return process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
}

function isContainedOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isStrictlyContained(root: string, candidate: string): boolean {
  return !samePath(root, candidate) && isContainedOrEqual(root, candidate);
}

async function lstatOptional(candidate: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(candidate) as Stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function lstatBigIntOptional(candidate: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(candidate, { bigint: true }) as BigIntStats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertNotSymlink(candidate: string, label: string): Promise<void> {
  const stat = await lstatOptional(candidate);
  if (stat?.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`${label} must not be a symlink or junction: ${candidate}`);
  }
}

async function assertRealDirectory(candidate: string, label: string): Promise<void> {
  const stat = await lstatOptional(candidate);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(
      `${label} must be a real directory, not a file, symlink, or junction: ${candidate}`,
    );
  }
}

async function prepareRoots(): Promise<void> {
  const dataRoot = getDataDir();
  const workspacesRoot = getWorkspacesDir();
  await fs.mkdir(dataRoot, { recursive: true });
  await assertRealDirectory(dataRoot, 'FLUJO data root');
  await assertNotSymlink(workspacesRoot, 'Workspaces root');
  await fs.mkdir(workspacesRoot, { recursive: true });
  await assertRealDirectory(workspacesRoot, 'Workspaces root');

  const diskEntries = await fs.readdir(workspacesRoot);
  const aliases = diskEntries.filter(name => name.toLowerCase() === DEFAULT_WORKSPACE.toLowerCase());
  if (aliases.some(name => name !== DEFAULT_WORKSPACE) || aliases.length > 1) {
    throw new WorkspaceMigrationUnsafePathError(
      `Default workspace has a case-alias collision: ${aliases.join(', ')}`,
    );
  }

  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  await assertNotSymlink(workspaceRoot, 'Default workspace root');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await assertRealDirectory(workspaceRoot, 'Default workspace root');
  const canonicalWorkspaces = await fs.realpath(workspacesRoot);
  const canonicalWorkspace = await fs.realpath(workspaceRoot);
  if (!isStrictlyContained(canonicalWorkspaces, canonicalWorkspace)) {
    throw new WorkspaceMigrationUnsafePathError(
      `Default workspace escapes the workspaces root: ${workspaceRoot}`,
    );
  }
  await assertNotSymlink(markerPath(), 'Workspace layout marker');
  await assertNotSymlink(journalPath(), 'Workspace migration journal');
  await assertNotSymlink(fastJournalPath(), 'Fast workspace migration journal');
}

async function syncDirectory(candidate: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(candidate, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    )) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Atomic metadata replacement. This intentionally replaces `destination`. */
async function renameReplacingWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt >= METADATA_RENAME_ATTEMPTS
        || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')
      ) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 25));
    }
  }
}

type NoReplaceMoveKind = 'file' | 'directory' | 'link';

type NoReplaceMoveBindings = {
  sourceIdentity: FastRootIdentity;
  destinationParentIdentity: FastRootIdentity;
};

const WINDOWS_NO_REPLACE_MOVE_SCRIPT = Buffer.from(`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class FlujoBoundMove {
  const uint FILE_LIST_DIRECTORY=0x1, FILE_ADD_FILE=0x2, FILE_ADD_SUBDIRECTORY=0x4;
  const uint FILE_TRAVERSE=0x20, FILE_READ_ATTRIBUTES=0x80, DELETE=0x10000, SYNCHRONIZE=0x100000;
  const uint SHARE_READ_WRITE=0x3, OPEN_EXISTING=3;
  const uint OPEN_REPARSE_POINT=0x00200000, BACKUP_SEMANTICS=0x02000000;
  const uint ATTR_DIRECTORY=0x10, ATTR_REPARSE_POINT=0x400;

  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct HANDLE_INFO {
    public uint Attributes;
    public FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public UIntPtr Information;
  }

  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HANDLE_INFO info);
  [DllImport("ntdll.dll")]
  static extern int NtSetInformationFile(SafeFileHandle handle, out IO_STATUS_BLOCK iosb,
    IntPtr info, uint length, int infoClass);
  [DllImport("ntdll.dll")]
  static extern uint RtlNtStatusToDosError(int status);

  static SafeFileHandle Open(string path, uint access) {
    SafeFileHandle handle=CreateFile(path,access,SHARE_READ_WRITE,IntPtr.Zero,OPEN_EXISTING,
      OPEN_REPARSE_POINT|BACKUP_SEMANTICS,IntPtr.Zero);
    if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateFileW failed: "+path);
    return handle;
  }
  static HANDLE_INFO Info(SafeFileHandle handle,string path) {
    HANDLE_INFO info;
    if(!GetFileInformationByHandle(handle,out info))
      throw new Win32Exception(Marshal.GetLastWin32Error(),"Identity query failed: "+path);
    return info;
  }
  static decimal Join(uint high,uint low) { return (decimal)high*4294967296m+low; }
  static string Identity(HANDLE_INFO info) {
    decimal birthNs=(Join(info.Creation.High,info.Creation.Low)-116444736000000000m)*100m;
    return info.Volume.ToString(CultureInfo.InvariantCulture)+"/"+
      Join(info.IndexHigh,info.IndexLow).ToString(CultureInfo.InvariantCulture)+"/"+
      birthNs.ToString(CultureInfo.InvariantCulture);
  }
  static void ExpectIdentity(HANDLE_INFO info,string expected,string label) {
    string actual=Identity(info);
    if(!String.Equals(actual,expected,StringComparison.Ordinal))
      throw new InvalidOperationException(label+" identity changed; expected "+expected+", actual "+actual);
  }
  static void ExpectKind(HANDLE_INFO info,string kind) {
    bool directory=(info.Attributes&ATTR_DIRECTORY)!=0;
    bool reparse=(info.Attributes&ATTR_REPARSE_POINT)!=0;
    bool valid=(kind=="directory" && directory && !reparse) ||
      (kind=="file" && !directory && !reparse) ||
      (kind=="link" && reparse);
    if(!valid) throw new InvalidOperationException("Source type changed before its bound move.");
  }

  public static void NoReplace(string source,string destinationParent,string destinationName,
      string sourceIdentity,string destinationParentIdentity,string kind) {
    if(String.IsNullOrEmpty(destinationName) || destinationName=="." || destinationName==".." ||
       destinationName.IndexOfAny(new char[]{'\\\\','/','\\0'})>=0)
      throw new ArgumentException("Destination must be one simple name.");

    using(SafeFileHandle sourceHandle=Open(source,DELETE|FILE_READ_ATTRIBUTES|SYNCHRONIZE))
    using(SafeFileHandle parentHandle=Open(destinationParent,FILE_LIST_DIRECTORY|FILE_ADD_FILE|
      FILE_ADD_SUBDIRECTORY|FILE_TRAVERSE|FILE_READ_ATTRIBUTES|SYNCHRONIZE)) {
      HANDLE_INFO sourceInfo=Info(sourceHandle,source);
      HANDLE_INFO parentInfo=Info(parentHandle,destinationParent);
      ExpectIdentity(sourceInfo,sourceIdentity,"Source");
      ExpectIdentity(parentInfo,destinationParentIdentity,"Destination parent");
      ExpectKind(sourceInfo,kind);
      if((parentInfo.Attributes&ATTR_DIRECTORY)==0 || (parentInfo.Attributes&ATTR_REPARSE_POINT)!=0)
        throw new InvalidOperationException("Destination parent is not a real directory.");
      if(sourceInfo.Volume!=parentInfo.Volume)
        throw new InvalidOperationException("Source and destination use different volumes.");

      byte[] name=Encoding.Unicode.GetBytes(destinationName);
      int rootOffset=IntPtr.Size==8?8:4;
      int lengthOffset=IntPtr.Size==8?16:8;
      int nameOffset=IntPtr.Size==8?20:12;
      byte[] zeroed=new byte[nameOffset+name.Length+2];
      IntPtr buffer=Marshal.AllocHGlobal(zeroed.Length);
      try {
        Marshal.Copy(zeroed,0,buffer,zeroed.Length);
        Marshal.WriteIntPtr(buffer,rootOffset,parentHandle.DangerousGetHandle());
        Marshal.WriteInt32(buffer,lengthOffset,name.Length);
        Marshal.Copy(name,0,IntPtr.Add(buffer,nameOffset),name.Length);
        IO_STATUS_BLOCK iosb;
        int status=NtSetInformationFile(sourceHandle,out iosb,buffer,(uint)zeroed.Length,10);
        if(status<0) throw new Win32Exception((int)RtlNtStatusToDosError(status),
          "NtSetInformationFile failed (NTSTATUS 0x"+((uint)status).ToString("X8")+")");
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }
}
'@
  [Console]::Out.WriteLine('{"ready":true}')
  while(($line=[Console]::In.ReadLine()) -ne $null) {
    $request=$null
    try {
      $request=$line | ConvertFrom-Json
      [FlujoBoundMove]::NoReplace(
        $request.source,
        $request.destinationParent,
        $request.destinationName,
        $request.sourceIdentity,
        $request.destinationParentIdentity,
        $request.kind
      )
      [Console]::Out.WriteLine((@{id=$request.id;ok=$true} | ConvertTo-Json -Compress))
    } catch {
      [Console]::Out.WriteLine((@{
        id=$request.id
        ok=$false
        error=$_.Exception.GetBaseException().ToString()
      } | ConvertTo-Json -Compress))
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().ToString())
  exit 1
}
`, 'utf16le').toString('base64');

const POSIX_NO_REPLACE_MOVE_SCRIPT = `
import ctypes
import errno
import os
import stat
import sys

def fail(value, message, candidate=None):
    print('FLUJO_ERRNO=' + errno.errorcode.get(value, 'EIO'), file=sys.stderr)
    raise OSError(value, message, candidate)

source = os.environ['FLUJO_MOVE_SOURCE']
destination = os.environ['FLUJO_MOVE_DESTINATION']
source_parent = os.path.dirname(source)
destination_parent = os.path.dirname(destination)
source_name = os.path.basename(source)
destination_name = os.path.basename(destination)
kind = os.environ['FLUJO_MOVE_KIND']
expected_source = os.environ['FLUJO_MOVE_SOURCE_ID'].split('/')
expected_parent = os.environ['FLUJO_MOVE_DESTINATION_PARENT_ID'].split('/')
if (not source_name or source_name in ('.', '..') or
        source != os.path.join(source_parent, source_name)):
    fail(errno.EINVAL, 'source must end in one simple name', source)
if (not destination_name or destination_name in ('.', '..') or
        destination != os.path.join(destination_parent, destination_name)):
    fail(errno.EINVAL, 'destination must end in one simple name', destination)

libc = ctypes.CDLL(None, use_errno=True)

if sys.platform.startswith('linux'):
    try:
        move = libc.renameat2
    except AttributeError:
        fail(errno.ENOSYS, 'libc does not expose renameat2')
    no_replace_flag = 1
elif sys.platform == 'darwin':
    try:
        move = libc.renameatx_np
    except AttributeError:
        fail(errno.ENOSYS, 'libc does not expose renameatx_np')
    no_replace_flag = 4
else:
    fail(errno.ENOSYS, 'unsupported platform for atomic no-clobber move')

move.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
move.restype = ctypes.c_int

def rename_no_replace(from_fd, from_name, to_fd, to_name):
    ctypes.set_errno(0)
    result = move(from_fd, os.fsencode(from_name), to_fd, os.fsencode(to_name), no_replace_flag)
    return result, ctypes.get_errno()

directory_flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
directory_flags |= getattr(os, 'O_CLOEXEC', 0)
source_parent_fd = -1
destination_parent_fd = -1
try:
    # Bind both parents across validation and rename so a lexical parent swap
    # cannot redirect the operation into another directory.
    source_parent_fd = os.open(source_parent, directory_flags)
    destination_parent_fd = os.open(destination_parent, directory_flags)
    source_stat = os.stat(source_name, dir_fd=source_parent_fd, follow_symlinks=False)
    parent_stat = os.fstat(destination_parent_fd)
    if [str(source_stat.st_dev), str(source_stat.st_ino)] != expected_source[:2]:
        fail(errno.ESTALE, 'source identity changed before bound move', source)
    if [str(parent_stat.st_dev), str(parent_stat.st_ino)] != expected_parent[:2]:
        fail(errno.ESTALE, 'destination parent identity changed before bound move', destination_parent)
    if stat.S_ISLNK(parent_stat.st_mode) or not stat.S_ISDIR(parent_stat.st_mode):
        fail(errno.ENOTDIR, 'destination parent is not a real directory', destination_parent)
    valid_kind = ((kind == 'directory' and stat.S_ISDIR(source_stat.st_mode)) or
                  (kind == 'file' and stat.S_ISREG(source_stat.st_mode)) or
                  (kind == 'link' and stat.S_ISLNK(source_stat.st_mode)))
    if not valid_kind:
        fail(errno.ESTALE, 'source type changed before bound move', source)
    if source_stat.st_dev != parent_stat.st_dev:
        fail(errno.EXDEV, 'source and destination use different filesystems', destination)

    result, value = rename_no_replace(
        source_parent_fd,
        source_name,
        destination_parent_fd,
        destination_name,
    )
    if result != 0:
        fail(value, os.strerror(value), destination)

    # POSIX has no rename-by-inode primitive. Detect a final-component swap in
    # the syscall window and roll it back only with another no-replace move.
    try:
        moved_stat = os.stat(
            destination_name,
            dir_fd=destination_parent_fd,
            follow_symlinks=False,
        )
    except OSError as error:
        fail(error.errno or errno.ESTALE, 'moved entry disappeared before identity validation', destination)
    if [str(moved_stat.st_dev), str(moved_stat.st_ino)] != expected_source[:2]:
        rollback, rollback_errno = rename_no_replace(
            destination_parent_fd,
            destination_name,
            source_parent_fd,
            source_name,
        )
        if rollback == 0:
            fail(errno.ESTALE, 'unexpected source was moved and safely rolled back', source)
        fail(
            errno.ESTALE,
            'unexpected source was moved; no-replace rollback was blocked by ' +
            errno.errorcode.get(rollback_errno, str(rollback_errno)),
            destination,
        )
finally:
    if destination_parent_fd >= 0:
        os.close(destination_parent_fd)
    if source_parent_fd >= 0:
        os.close(source_parent_fd)
`;

type WindowsMoveRequest = {
  id: string;
  source: string;
  destinationParent: string;
  destinationName: string;
  sourceIdentity: string;
  destinationParentIdentity: string;
  kind: NoReplaceMoveKind;
};

type WindowsMoveSession = {
  request(command: WindowsMoveRequest): Promise<void>;
  ref(): void;
  unref(): void;
  close(): void;
};

let windowsMoveSession: WindowsMoveSession | undefined;
let windowsMoveQueue: Promise<void> = Promise.resolve();
let windowsMoveIdleTimer: ReturnType<typeof setTimeout> | undefined;

function windowsMoveTimeoutError(message: string): Error {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ETIMEDOUT';
  return error;
}

function startWindowsMoveSession(executable: string): WindowsMoveSession {
  const child = spawn(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_NO_REPLACE_MOVE_SCRIPT],
    {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '';
  let stderr = '';
  let ready = false;
  let stopping = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const pending = new Map<string, {
    resolve(): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const setReferenced = (referenced: boolean): void => {
    const method = referenced ? 'ref' : 'unref';
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
      (handle as unknown as { ref?(): void; unref?(): void })[method]?.();
    }
  };

  const fail = (error: Error): void => {
    readyReject?.(error);
    readyReject = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  const stop = (error?: Error): void => {
    if (error) fail(error);
    if (stopping) return;
    stopping = true;
    if (windowsMoveSession === session) windowsMoveSession = undefined;
    child.kill();
    setReferenced(false);
  };
  const readyTimeout = setTimeout(() => {
    stop(windowsMoveTimeoutError(
      `Windows no-clobber helper did not become ready within `
      + `${WINDOWS_MOVE_HELPER_START_TIMEOUT_MS}ms.`,
    ));
  }, WINDOWS_MOVE_HELPER_START_TIMEOUT_MS);
  const consumeLine = (line: string): void => {
    if (!line.trim()) return;
    let response: { ready?: boolean; id?: string; ok?: boolean; error?: string };
    try {
      response = JSON.parse(line) as typeof response;
    } catch (error) {
      stop(new Error(`Windows no-clobber helper returned invalid output: ${line.slice(0, 512)}`, {
        cause: error,
      }));
      return;
    }
    if (response.ready === true && !ready) {
      ready = true;
      readyResolve?.();
      readyResolve = undefined;
      readyReject = undefined;
      clearTimeout(readyTimeout);
      return;
    }
    if (!response.id) return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timeout);
    if (response.ok === true) request.resolve();
    else request.reject(new Error(response.error || 'Windows bound move failed without an error.'));
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline).replace(/\r$/, '');
      stdout = stdout.slice(newline + 1);
      consumeLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
  });
  child.once('error', error => stop(error));
  child.once('close', (code, signal) => {
    stopping = true;
    clearTimeout(readyTimeout);
    const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 2_048);
    fail(new Error(
      `Windows no-clobber helper stopped${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`
      + `${detail ? `: ${detail}` : ''}`,
    ));
    if (windowsMoveSession === session) windowsMoveSession = undefined;
  });

  const session: WindowsMoveSession = {
    async request(command) {
      await readyPromise;
      if (stopping) throw new Error('Windows no-clobber helper is stopping.');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!pending.delete(command.id)) return;
          const error = windowsMoveTimeoutError(
            `Windows no-clobber move ${command.id} did not complete within `
            + `${WINDOWS_MOVE_HELPER_REQUEST_TIMEOUT_MS}ms.`,
          );
          reject(error);
          stop(error);
        }, WINDOWS_MOVE_HELPER_REQUEST_TIMEOUT_MS);
        pending.set(command.id, { resolve, reject, timeout });
        child.stdin.write(`${JSON.stringify(command)}\n`, error => {
          if (!error) return;
          const request = pending.get(command.id);
          if (!request) return;
          pending.delete(command.id);
          clearTimeout(request.timeout);
          reject(error);
        });
      });
    },
    ref: () => setReferenced(true),
    unref: () => setReferenced(false),
    close: () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(readyTimeout);
      if (windowsMoveSession === session) windowsMoveSession = undefined;
      child.stdin.end();
      setReferenced(false);
      const forceClose = setTimeout(() => child.kill(), 1_000);
      forceClose.unref?.();
      child.once('close', () => clearTimeout(forceClose));
    },
  };
  return session;
}

function scheduleWindowsMoveSessionClose(session: WindowsMoveSession): void {
  if (windowsMoveIdleTimer) clearTimeout(windowsMoveIdleTimer);
  windowsMoveIdleTimer = setTimeout(() => {
    windowsMoveIdleTimer = undefined;
    if (windowsMoveSession !== session) return;
    windowsMoveSession = undefined;
    session.close();
  }, WINDOWS_MOVE_HELPER_IDLE_MS);
  session.unref();
  windowsMoveIdleTimer.unref?.();
}

function formatRootIdentity(identity: FastRootIdentity): string {
  return `${identity.dev}/${identity.ino}/${identity.birthtimeNs}`;
}

async function bindNoReplaceMove(
  source: string,
  destinationParent: string,
): Promise<NoReplaceMoveBindings> {
  const [sourceStat, parentStat] = await Promise.all([
    lstatBigIntOptional(source),
    lstatBigIntOptional(destinationParent),
  ]);
  const sourceIdentity = sourceStat && rootIdentity(sourceStat);
  const destinationParentIdentity = parentStat && rootIdentity(parentStat);
  if (!sourceIdentity) {
    throw new WorkspaceMigrationConflictError(
      'workspace move',
      source,
      destinationParent,
      'source disappeared or has no stable filesystem identity',
    );
  }
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink() || !destinationParentIdentity) {
    throw new WorkspaceMigrationUnsafePathError(
      `Workspace move destination parent is not a stable real directory: ${destinationParent}`,
    );
  }
  return { sourceIdentity, destinationParentIdentity };
}

async function windowsMoveNoReplace(
  source: string,
  destination: string,
  kind: NoReplaceMoveKind,
  bindings?: NoReplaceMoveBindings,
): Promise<void> {
  const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim();
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new WorkspaceMigrationMarkerError(
      'Windows system root is unavailable; refusing a workspace move without no-clobber semantics.',
    );
  }
  const executable = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const destinationParent = path.dirname(destination);
  const effectiveBindings = bindings ?? await bindNoReplaceMove(source, destinationParent);
  const operation = windowsMoveQueue.then(async () => {
    if (windowsMoveIdleTimer) {
      clearTimeout(windowsMoveIdleTimer);
      windowsMoveIdleTimer = undefined;
    }
    const session = windowsMoveSession ??= startWindowsMoveSession(executable);
    session.ref();
    try {
      await session.request({
        id: randomUUID(),
        source,
        destinationParent,
        destinationName: path.basename(destination),
        sourceIdentity: formatRootIdentity(effectiveBindings.sourceIdentity),
        destinationParentIdentity: formatRootIdentity(
          effectiveBindings.destinationParentIdentity,
        ),
        kind,
      });
    } finally {
      scheduleWindowsMoveSessionClose(session);
    }
  });
  windowsMoveQueue = operation.catch(() => undefined);
  await operation;
}

async function findPython3Executable(): Promise<string> {
  const configured = process.env.FLUJO_PYTHON3?.trim();
  const candidates = [
    configured,
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',
    ...((process.env.PATH ?? '').split(path.delimiter)
      .filter(directory => path.isAbsolute(directory))
      .map(directory => path.join(directory, 'python3'))),
  ].filter((candidate): candidate is string => Boolean(candidate && path.isAbsolute(candidate)));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const canonical = await fs.realpath(candidate);
      const stat = await fs.stat(canonical);
      if (!stat.isFile()) continue;
      await fs.access(canonical, fsConstants.X_OK);
      return canonical;
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
  }
  throw new WorkspaceMigrationMarkerError(
    'Python 3 is required for an atomic no-clobber workspace move on this platform. '
    + 'No data was moved; install Python 3 or set FLUJO_PYTHON3 to its absolute executable path.',
  );
}

async function posixMoveNoReplace(
  source: string,
  destination: string,
  kind: NoReplaceMoveKind,
  bindings?: NoReplaceMoveBindings,
): Promise<void> {
  const executable = await findPython3Executable();
  const effectiveBindings = bindings ?? await bindNoReplaceMove(source, path.dirname(destination));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-I', '-c', POSIX_NO_REPLACE_MOVE_SCRIPT], {
      env: {
        ...process.env,
        FLUJO_MOVE_SOURCE: source,
        FLUJO_MOVE_DESTINATION: destination,
        FLUJO_MOVE_KIND: kind,
        FLUJO_MOVE_SOURCE_ID: formatRootIdentity(effectiveBindings.sourceIdentity),
        FLUJO_MOVE_DESTINATION_PARENT_ID: formatRootIdentity(
          effectiveBindings.destinationParentIdentity,
        ),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 2_048);
      const failure = new Error(
        `POSIX no-clobber move failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`
        + `${detail ? `: ${detail}` : ''}`,
      ) as NodeJS.ErrnoException;
      failure.code = stderr.match(/FLUJO_ERRNO=([A-Z0-9_]+)/)?.[1];
      reject(failure);
    });
  });
}

/**
 * Move one filesystem object without replacing an existing final component.
 * Windows' Node rename binding requests replace semantics, so use the .NET
 * Move APIs, which call the native non-replacing move operation.
 */
async function moveNoReplaceOnce(
  source: string,
  destination: string,
  kind: NoReplaceMoveKind,
  bindings?: NoReplaceMoveBindings,
): Promise<void> {
  const effectiveBindings = bindings ?? await bindNoReplaceMove(
    source,
    path.dirname(destination),
  );
  await moveFaultHook?.(source, destination, kind);
  if (process.platform === 'win32') {
    await windowsMoveNoReplace(source, destination, kind, effectiveBindings);
    return;
  }
  if (process.platform === 'linux' || process.platform === 'darwin') {
    await posixMoveNoReplace(source, destination, kind, effectiveBindings);
    return;
  }
  throw new WorkspaceMigrationMarkerError(
    `Atomic no-clobber workspace moves are unsupported on ${process.platform}; no data was moved.`,
  );
}

async function moveNoReplaceWithRetry(
  source: string,
  destination: string,
  kind: NoReplaceMoveKind,
  beforeAttempt?: () => Promise<void>,
  bindings?: NoReplaceMoveBindings,
): Promise<void> {
  // Bind once before any fault hook or retry. A transient native error must
  // never let a later attempt adopt a replacement at the same lexical path.
  const effectiveBindings = bindings ?? await bindNoReplaceMove(
    source,
    path.dirname(destination),
  );
  for (let attempt = 1; ; attempt += 1) {
    await beforeAttempt?.();
    try {
      await moveNoReplaceOnce(source, destination, kind, effectiveBindings);
      return;
    } catch (error) {
      // A failed native operation must never turn into a retry that acts on a
      // newly substituted source or an occupied destination.
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw error;
      if (!(await lstatOptional(source)) || await lstatOptional(destination)) throw error;
      if (attempt >= METADATA_RENAME_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 25));
    }
  }
}

async function writeJsonAtomic(
  file: string,
  value: unknown,
  options: { createParent?: boolean } = {},
): Promise<void> {
  await assertNotSymlink(file, 'Migration metadata file');
  const parent = path.dirname(file);
  if (options.createParent === false) {
    await assertRealDirectory(parent, 'Migration metadata parent');
  } else {
    await fs.mkdir(parent, { recursive: true });
  }
  const temp = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameReplacingWithRetry(temp, file);
    await syncDirectory(parent);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

async function readLockOwner(dir: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, OWNER_FILE), 'utf8')) as LockOwner;
    if (
      typeof parsed?.token === 'string'
      && Number.isInteger(parsed.pid)
      && typeof parsed.hostname === 'string'
      && typeof parsed.startedAt === 'string'
      && typeof parsed.heartbeatAt === 'string'
    ) return parsed;
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function lockHeartbeatTime(dir: string, owner: LockOwner): Promise<number> {
  const file = path.join(dir, HEARTBEAT_FILE);
  const stat = await lstatOptional(file);
  if (!stat) return Date.parse(owner.heartbeatAt);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Migration heartbeat is not a regular file: ${file}`);
  }
  const token = await fs.readFile(file, 'utf8');
  if (token !== owner.token) {
    throw new WorkspaceMigrationUnsafePathError(`Migration heartbeat token does not match its owner: ${file}`);
  }
  return stat.mtimeMs;
}

async function pidIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function removeStaleLockIfSafe(dir: string): Promise<boolean> {
  const stat = await lstatBigIntOptional(dir);
  if (!stat) return true;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Migration lock is not a real directory: ${dir}`);
  }
  const owner = await readLockOwner(dir);
  if (owner) {
    const heartbeat = await lockHeartbeatTime(dir, owner);
    const expired = !Number.isFinite(heartbeat) || Date.now() - heartbeat > LOCK_LEASE_MS;
    if (owner.hostname === os.hostname()) {
      if (await pidIsAlive(owner.pid)) return false;
    } else if (!expired) {
      return false;
    }
  } else if (Date.now() - Number(stat.mtimeMs) <= LOCK_LEASE_MS) {
    return false;
  }
  migrationConsole('reclaiming stale migration lock', {
    lock: dir,
    ownerPid: owner?.pid,
    ownerHost: owner?.hostname,
  });
  // Atomically move the stale lock out of the acquisition path before deleting
  // it. A second reclaimer may observe ENOENT, while a new owner can safely mkdir
  // the original path without its lock being removed by our cleanup.
  const quarantine = path.join(
    path.dirname(dir),
    `.${path.basename(dir)}.stale-${process.pid}-${randomUUID()}`,
  );
  try {
    const current = await lstatBigIntOptional(dir);
    if (!current) return true;
    if (
      current.dev !== stat.dev
      || current.ino !== stat.ino
      || current.birthtimeNs !== stat.birthtimeNs
    ) return false;
    if (await lstatOptional(quarantine)) {
      throw new WorkspaceMigrationUnsafePathError(
        `Stale-lock quarantine path unexpectedly exists: ${quarantine}`,
      );
    }
    const parentStat = await lstatBigIntOptional(path.dirname(dir));
    const sourceIdentity = rootIdentity(stat);
    const destinationParentIdentity = parentStat && rootIdentity(parentStat);
    if (
      !sourceIdentity
      || !parentStat?.isDirectory()
      || parentStat.isSymbolicLink()
      || !destinationParentIdentity
    ) {
      throw new WorkspaceMigrationUnsafePathError(
        `Migration lock or its parent has no stable filesystem identity: ${dir}`,
      );
    }
    await moveNoReplaceOnce(dir, quarantine, 'directory', {
      sourceIdentity,
      destinationParentIdentity,
    });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
      || !(await lstatOptional(dir))
    ) return true;
    throw error;
  }
  await fs.rm(quarantine, { recursive: true, force: false });
  return true;
}

async function acquireMigrationLock(): Promise<{ release(): Promise<void> }> {
  const dir = lockPath();
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(dir);
      let heartbeatHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        await writeJsonAtomic(path.join(dir, OWNER_FILE), owner);
        heartbeatHandle = await fs.open(path.join(dir, HEARTBEAT_FILE), 'wx+', 0o600);
        await heartbeatHandle.writeFile(owner.token, 'utf8');
        await heartbeatHandle.sync();
        await syncDirectory(dir);
      } catch (error) {
        // mkdir is the lock acquisition. If publishing our owner record fails,
        // do not strand an unreadable lock that would block every later start.
        await heartbeatHandle?.close().catch(() => undefined);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      let heartbeatTask: Promise<void> | undefined;
      const heartbeat = setInterval(() => {
        if (released || heartbeatTask) return;
        heartbeatTask = (async () => {
          const current = await readLockOwner(dir);
          if (released || current?.token !== owner.token) return;
          owner.heartbeatAt = new Date().toISOString();
          await checkpoint('before-lock-heartbeat-write');
          if (released) return;
          // Update the file opened when this lock was acquired. If another host
          // has reclaimed/renamed our expired directory, this handle still
          // points at the old inode and can never overwrite the successor's
          // owner metadata at the reused path.
          const now = new Date();
          await heartbeatHandle!.utimes(now, now);
          await heartbeatHandle!.sync();
        })().catch(error => log.warn('Workspace migration lock heartbeat failed', error))
          .finally(() => { heartbeatTask = undefined; });
      }, lockHeartbeatIntervalMs);
      heartbeat.unref?.();
      return {
        async release() {
          released = true;
          clearInterval(heartbeat);
          await heartbeatTask;
          await heartbeatHandle?.close();
          const current = await readLockOwner(dir).catch(() => undefined);
          if (current?.token === owner.token) await fs.rm(dir, { recursive: true, force: false });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && await removeStaleLockIfSafe(dir)) continue;
      const current = await readLockOwner(dir).catch(() => undefined);
      throw new WorkspaceMigrationLockedError(
        `Another FLUJO process is migrating the workspace layout` +
        `${current ? ` (pid ${current.pid} on ${current.hostname})` : ''}.`,
      );
    }
  }
  throw new WorkspaceMigrationLockedError('Could not acquire the workspace migration lock.');
}

async function readMarker(): Promise<WorkspaceLayoutMarker | undefined> {
  const file = markerPath();
  const stat = await lstatOptional(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationMarkerError(`Workspace layout marker is not a regular file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new WorkspaceMigrationMarkerError(`Workspace layout marker is corrupt or unreadable: ${file}`, {
      cause: error,
    });
  }
  const marker = parsed as Partial<WorkspaceLayoutMarker>;
  if (!Number.isInteger(marker.version) || (marker.version ?? 0) < 1) {
    throw new WorkspaceMigrationMarkerError(`Workspace layout marker has an invalid version: ${file}`);
  }
  if ((marker.version ?? 0) > WORKSPACE_LAYOUT_VERSION) {
    throw new WorkspaceMigrationMarkerError(
      `Workspace layout version ${marker.version} is newer than this FLUJO build supports ` +
      `(maximum ${WORKSPACE_LAYOUT_VERSION}). Refusing to modify it.`,
    );
  }
  if (
    typeof marker.completedAt !== 'string'
    || !Number.isFinite(Date.parse(marker.completedAt))
    || marker.defaultWorkspace !== DEFAULT_WORKSPACE
    || !marker.subtrees
    || typeof marker.subtrees !== 'object'
  ) {
    throw new WorkspaceMigrationMarkerError(`Workspace layout marker has an invalid schema: ${file}`);
  }
  if (marker.version === WORKSPACE_LAYOUT_VERSION) {
    if (
      typeof marker.transactionId !== 'string'
      || !UUID_PATTERN.test(marker.transactionId)
      || typeof marker.manifestDigest !== 'string'
      || !SHA256_PATTERN.test(marker.manifestDigest)
      || WORKSPACE_SUBTREES.some(subtree => !SUBTREE_OUTCOMES.has(
        (marker.subtrees as Record<string, SubtreeOutcome>)[subtree],
      ))
    ) {
      throw new WorkspaceMigrationMarkerError(`Workspace layout v2 marker is incomplete: ${file}`);
    }
  }
  return marker as WorkspaceLayoutMarker;
}

async function readJournal(): Promise<MigrationJournal | undefined> {
  const file = journalPath();
  const stat = await lstatOptional(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationMarkerError(`Workspace migration journal is not a regular file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new WorkspaceMigrationMarkerError(`Workspace migration journal is corrupt or unreadable: ${file}`, {
      cause: error,
    });
  }
  const journal = parsed as Partial<MigrationJournal>;
  if (
    !SUPPORTED_JOURNAL_SCHEMA_VERSIONS.has(journal.schemaVersion ?? -1)
    || journal.targetVersion !== WORKSPACE_LAYOUT_VERSION
    || typeof journal.transactionId !== 'string'
    || !Array.isArray(journal.entries)
  ) {
    throw new WorkspaceMigrationMarkerError(`Workspace migration journal has an unsupported schema: ${file}`);
  }
  validateJournalPaths(journal as MigrationJournal);
  await validateJournalDiskCandidates(journal as MigrationJournal);
  return journal as MigrationJournal;
}

async function readFastJournal(): Promise<FastMigrationJournal | undefined> {
  const file = fastJournalPath();
  const stat = await lstatOptional(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationMarkerError(`Fast workspace migration journal is not a regular file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new WorkspaceMigrationMarkerError(
      `Fast workspace migration journal is corrupt or unreadable: ${file}`,
      { cause: error },
    );
  }
  const journal = parsed as Partial<FastMigrationJournal>;
  if (journal.schemaVersion === 1) {
    throw new WorkspaceMigrationMarkerError(
      `Fast workspace migration journal schema 1 cannot be resumed by the safe mover: ${file}. `
      + 'No files were changed by this startup. Preserve the journal and both legacy/workspace data trees; '
      + 'do not delete transaction files or retry with an older build.',
    );
  }
  if (
    !SUPPORTED_FAST_JOURNAL_SCHEMA_VERSIONS.has(journal.schemaVersion ?? -1)
    || journal.targetVersion !== WORKSPACE_LAYOUT_VERSION
    || typeof journal.transactionId !== 'string'
    || !Array.isArray(journal.entries)
  ) {
    throw new WorkspaceMigrationMarkerError(
      `Fast workspace migration journal has an unsupported schema: ${file}`,
    );
  }
  try {
    validateFastJournal(journal as FastMigrationJournal);
  } catch (error) {
    if (journal.schemaVersion === LEGACY_FAST_JOURNAL_SCHEMA_VERSION) {
      throw new WorkspaceMigrationMarkerError(
        `Fast workspace migration journal schema 2 contains legacy link state that cannot be `
        + `resumed safely: ${file}. No files were changed by this startup; preserve the journal `
        + 'and its .old/.new artifacts for conservative recovery.',
        { cause: error },
      );
    }
    throw error;
  }
  return journal as FastMigrationJournal;
}

function pathExactlyMatches(actual: unknown, expected: string): actual is string {
  return typeof actual === 'string'
    && path.isAbsolute(actual)
    && path.normalize(actual) === path.normalize(expected);
}

function isDigest(value: unknown, optional = false): value is string | undefined {
  return (optional && value === undefined)
    || (typeof value === 'string' && SHA256_PATTERN.test(value));
}

function isMode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o777;
}

function validateRetainedManifest(entries: unknown, digest: string | undefined): entries is ManifestEntry[] {
  if (!Array.isArray(entries) || !digest || entries.length === 0) return false;
  const seen = new Set<string>();
  for (const value of entries) {
    const entry = value as Partial<ManifestEntry>;
    if (
      !entry
      || typeof entry.relativePath !== 'string'
      || entry.relativePath.includes('\0')
      || entry.relativePath.includes('\\')
      || path.posix.isAbsolute(entry.relativePath)
      || (
        entry.relativePath !== ''
        && entry.relativePath.split('/').some(part => part === '.' || part === '..' || part === '')
      )
      || seen.has(manifestPathIdentity(entry.relativePath))
      || !['directory', 'file', 'symlink'].includes(entry.type ?? '')
    ) return false;
    seen.add(manifestPathIdentity(entry.relativePath));
    if (
      entry.type === 'file'
      && (
        !isMode(entry.mode)
        || !Number.isSafeInteger(entry.size)
        || (entry.size ?? -1) < 0
        || !isDigest(entry.sha256)
        || !Number.isFinite(entry.atimeMs)
        || !Number.isFinite(entry.mtimeMs)
      )
    ) return false;
    if (entry.type === 'directory' && !isMode(entry.mode)) return false;
    if (
      entry.type === 'symlink'
      && (
        typeof entry.linkTarget !== 'string'
        || path.isAbsolute(entry.linkTarget)
        || !['file', 'directory', 'junction'].includes(entry.linkType ?? '')
      )
    ) return false;
  }
  if (!seen.has('') || entries.find(entry => entry.relativePath === '')?.type !== 'directory') return false;
  return manifestFromEntries(entries as ManifestEntry[]).digest === digest;
}

function validateJournalPaths(journal: MigrationJournal): void {
  const transactionRoot = path.join(transactionsPath(), journal.transactionId);
  if (!SUPPORTED_JOURNAL_SCHEMA_VERSIONS.has(journal.schemaVersion)) {
    throw new WorkspaceMigrationMarkerError(
      `Workspace migration journal schema ${journal.schemaVersion} is unsupported.`,
    );
  }
  if (!UUID_PATTERN.test(journal.transactionId)) {
    throw new WorkspaceMigrationMarkerError('Workspace migration journal has an invalid transaction id.');
  }
  if (
    typeof journal.createdAt !== 'string'
    || !Number.isFinite(Date.parse(journal.createdAt))
    || !JOURNAL_PHASES.has(journal.phase)
  ) {
    throw new WorkspaceMigrationMarkerError('Workspace migration journal has invalid lifecycle metadata.');
  }
  const ids = new Set<string>();
  for (const entry of journal.entries) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id)) {
      throw new WorkspaceMigrationMarkerError('Workspace migration journal contains duplicate/invalid entries.');
    }
    ids.add(entry.id);
    const hasForceRepublish = Object.prototype.hasOwnProperty.call(entry, 'forceRepublish');
    const forceRepublishIsValid = journal.schemaVersion === LEGACY_JOURNAL_SCHEMA_VERSION
      ? !hasForceRepublish
      : hasForceRepublish && typeof entry.forceRepublish === 'boolean';
    const expected = candidateForJournalId(entry.id);
    if (!expected) {
      throw new WorkspaceMigrationMarkerError(`Workspace migration journal has an unknown entry: ${entry.id}`);
    }
    if (
      entry.subtree !== expected.subtree
      || entry.requireDirectory !== expected.requireDirectory
      || !Array.isArray(entry.sources)
      || entry.sources.length !== expected.sources.length
      || !pathExactlyMatches(entry.destination, expected.destination)
      || !pathExactlyMatches(
        entry.destinationBackup,
        backupPath(expected.destination, journal.transactionId, true),
      )
      || !pathExactlyMatches(
        entry.stage,
        path.join(transactionRoot, 'stage', safeStageName(entry.id)),
      )
      || !isDigest(entry.expectedDigest)
      || !validateRetainedManifest(entry.expectedEntries, entry.expectedDigest)
      || !isDigest(entry.initialDestinationDigest, true)
      || (
        entry.destinationLinksToRelocate !== undefined
        && (
          !Number.isSafeInteger(entry.destinationLinksToRelocate)
          || entry.destinationLinksToRelocate < 1
          || !entry.initialDestinationDigest
        )
      )
      || !forceRepublishIsValid
      || (entry.forceRepublish === true && !entry.initialDestinationDigest)
      || !JOURNAL_STATES.has(entry.state)
      || !SUBTREE_OUTCOMES.has(entry.outcome)
    ) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal entry does not match the derived plan: ${entry.id}`,
      );
    }
    if (
      entry.sources.some(source => {
        if (!source || typeof source !== 'object') return true;
        return source.retainedMount === true
          ? !validateRetainedManifest(source.retainedEntries, source.initialDigest)
          : source.retainedMount !== undefined || source.retainedEntries !== undefined;
      })
    ) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal has invalid retained-mount metadata: ${entry.id}`,
      );
    }
    if (
      entry.sources.some(source => source.cleanupStarted !== undefined && typeof source.cleanupStarted !== 'boolean')
      || (
        entry.destinationBackupCleanupStarted !== undefined
        && typeof entry.destinationBackupCleanupStarted !== 'boolean'
      )
      || (entry.stageCleanupStarted !== undefined && typeof entry.stageCleanupStarted !== 'boolean')
    ) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal has invalid cleanup metadata: ${entry.id}`,
      );
    }
    for (let index = 0; index < expected.sources.length; index++) {
      const source = entry.sources[index];
      const expectedSource = expected.sources[index];
      if (
        !source
        || !pathExactlyMatches(source.path, expectedSource)
        || !pathExactlyMatches(source.backup, backupPath(expectedSource, journal.transactionId))
        || !isDigest(source.initialDigest, true)
      ) {
        throw new WorkspaceMigrationMarkerError(
          `Workspace migration journal source does not match the derived plan: ${entry.id}`,
        );
      }
    }
    if (entry.id.startsWith('mcp-servers/') && !entry.sources[0]?.initialDigest) {
      throw new WorkspaceMigrationMarkerError(
        `Dynamic MCP journal entry has no preflight digest: ${entry.id}`,
      );
    }
  }

  for (const required of baseCandidates()) {
    if (!ids.has(required.id)) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal is missing required entry: ${required.id}`,
      );
    }
  }
}

async function validateJournalDiskCandidates(journal: MigrationJournal): Promise<void> {
  if (!applicationSharesDataRoot()) return;
  const mcpRoot = path.join(getDataDir(), 'mcp-servers');
  const stat = await lstatOptional(mcpRoot);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationMarkerError(`Journal MCP root is unsafe: ${mcpRoot}`);
  }
  const journalIds = new Set(journal.entries.map(entry => entry.id));
  const sourceBackupSuffix = `.workspace-v2-${journal.transactionId}.bak`;
  for (const entry of await fs.readdir(mcpRoot, { withFileTypes: true })) {
    if (APP_OWNED_MCP_ENTRIES.has(entry.name.toLowerCase())) continue;
    let runtimeName = entry.name;
    if (TRANSACTION_BACKUP_NAME.test(entry.name)) {
      if (!entry.name.startsWith('.') || !entry.name.endsWith(sourceBackupSuffix)) {
        throw new WorkspaceMigrationMarkerError(
          `Unrelated/orphaned migration backup exists beside the journal: ${path.join(mcpRoot, entry.name)}`,
        );
      }
      runtimeName = entry.name.slice(1, -sourceBackupSuffix.length);
    }
    const id = `mcp-servers/${runtimeName}`;
    if (!candidateForJournalId(id) || !journalIds.has(id)) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration journal omits runtime MCP data: ${path.join(mcpRoot, entry.name)}`,
      );
    }
  }
}

async function writeJournal(journal: MigrationJournal): Promise<void> {
  validateJournalPaths(journal);
  await writeJsonAtomic(journalPath(), journal);
}

async function writeFastJournal(journal: FastMigrationJournal): Promise<void> {
  validateFastJournal(journal);
  await writeJsonAtomic(fastJournalPath(), journal);
}

function permissionMode(stat: Stats): number {
  return stat.mode & 0o777;
}

function defaultDirectoryMode(): number {
  // Node reports Windows directory permissions as 0666 even after chmod(0777).
  // Use the platform's observable value so a freshly staged empty directory
  // hashes exactly like the directory that was materialized.
  return process.platform === 'win32' ? 0o666 : 0o777 & ~process.umask();
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertManagedPathAncestors(candidate: string): Promise<void> {
  const dataRoot = path.resolve(getDataDir());
  const resolved = path.resolve(candidate);
  if (!isContainedOrEqual(dataRoot, resolved)) {
    throw new WorkspaceMigrationUnsafePathError(`Managed path escapes the FLUJO data root: ${candidate}`);
  }
  const relative = path.relative(dataRoot, resolved);
  let cursor = dataRoot;
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    const stat = await lstatOptional(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new WorkspaceMigrationUnsafePathError(
        `Managed path has a symlink or junction ancestor: ${cursor}`,
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new WorkspaceMigrationUnsafePathError(`Managed path ancestor is not a directory: ${cursor}`);
    }
  }
  const stat = await lstatOptional(resolved);
  if (!stat) return;
  const [canonicalDataRoot, canonicalCandidate] = await Promise.all([
    fs.realpath(dataRoot),
    fs.realpath(resolved),
  ]);
  if (!isContainedOrEqual(canonicalDataRoot, canonicalCandidate)) {
    throw new WorkspaceMigrationUnsafePathError(`Managed path resolves outside FLUJO data: ${candidate}`);
  }
}

async function hashFile(file: string, onBytes?: (bytes: number) => void): Promise<{
  mode: number;
  size: number;
  sha256: string;
  atimeMs: number;
  mtimeMs: number;
}> {
  const before = await fs.lstat(file) as Stats;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Expected a regular file while hashing: ${file}`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat() as Stats;
    if (
      !opened.isFile()
      || opened.nlink !== before.nlink
      || !sameFileIdentity(before, opened)
      || opened.size !== before.size
      || permissionMode(opened) !== permissionMode(before)
    ) {
      throw new WorkspaceMigrationUnsafePathError(`File changed or escaped while being opened: ${file}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
      onBytes?.((chunk as Buffer).byteLength);
    }
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat() as Promise<Stats>,
      fs.lstat(file) as Promise<Stats>,
    ]);
    if (
      !afterHandle.isFile()
      || !afterPath.isFile()
      || afterHandle.nlink !== opened.nlink
      || afterPath.nlink !== opened.nlink
      || !sameFileIdentity(opened, afterHandle)
      || !sameFileIdentity(opened, afterPath)
      || afterHandle.size !== opened.size
      || afterPath.size !== opened.size
      || afterHandle.mtimeMs !== opened.mtimeMs
      || afterPath.mtimeMs !== opened.mtimeMs
      || afterHandle.ctimeMs !== opened.ctimeMs
      || afterPath.ctimeMs !== opened.ctimeMs
      || permissionMode(afterHandle) !== permissionMode(opened)
      || permissionMode(afterPath) !== permissionMode(opened)
    ) throw new Error(`Workspace migration source changed while it was being read: ${file}`);
    return {
      mode: permissionMode(afterHandle),
      size: afterHandle.size,
      sha256: hash.digest('hex'),
      // Reading a file can itself advance atime. Capture the pre-read value so
      // the migration preserves user metadata rather than its own observation.
      atimeMs: before.atimeMs,
      mtimeMs: afterHandle.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

function manifestFromEntries(entries: ManifestEntry[]): PathManifest {
  const sorted = entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  // Timestamps are durable metadata, but they cannot be part of merge/content
  // identity: inventory reads can advance atime, and two byte-identical legacy
  // copies commonly have distinct mtimes. The journal and completion-marker
  // digest still authenticate the full expectedEntries chosen at preflight.
  // Stream the exact JSON array representation into the digest. Constructing a
  // second metadata array plus one giant JSON string caused a severe temporary
  // heap spike on real userdata repositories containing large node_modules.
  const identityHash = createHash('sha256');
  identityHash.update('[');
  for (let index = 0; index < sorted.length; index += 1) {
    const {
      atimeMs: _atimeMs,
      mtimeMs: _mtimeMs,
      ...identityEntry
    } = sorted[index];
    if (index > 0) identityHash.update(',');
    identityHash.update(JSON.stringify(identityEntry));
  }
  identityHash.update(']');
  return {
    entries: sorted,
    digest: identityHash.digest('hex'),
    emptyDirectory: sorted.length === 1 && sorted[0].relativePath === '' && sorted[0].type === 'directory',
    relocatedLinks: 0,
    relocatedLinkPaths: [],
    absoluteLinkPaths: [],
    hardLinkedFilePaths: [],
  };
}

function manifestEntryEqual(a: ManifestEntry, b: ManifestEntry): boolean {
  return a.type === b.type
    && a.mode === b.mode
    && a.size === b.size
    && a.sha256 === b.sha256
    && a.linkTarget === b.linkTarget
    && a.linkType === b.linkType;
}

function mergeManifests(
  manifests: Array<{ label: string; manifest: PathManifest }>,
  subtree: string,
  destination: string,
): PathManifest {
  const merged = new Map<string, { entry: ManifestEntry; label: string }>();
  for (const { label, manifest } of manifests) {
    for (const entry of manifest.entries) {
      const identity = manifestPathIdentity(entry.relativePath);
      const prior = merged.get(identity);
      if (!prior) {
        merged.set(identity, { entry, label });
        continue;
      }
      if (prior.entry.relativePath !== entry.relativePath) {
        throw new WorkspaceMigrationConflictError(
          subtree,
          prior.label,
          destination,
          `case-aliased paths ${JSON.stringify(prior.entry.relativePath)} and ` +
          `${JSON.stringify(entry.relativePath)} cannot be merged safely from ${label}`,
        );
      }
      if (!manifestEntryEqual(prior.entry, entry)) {
        throw new WorkspaceMigrationConflictError(
          subtree,
          prior.label,
          destination,
          `overlapping path ${JSON.stringify(entry.relativePath || '.')} differs in ${label}`,
        );
      }
    }
  }
  if (merged.size === 0) {
    return manifestFromEntries([{
      relativePath: '',
      type: 'directory',
      mode: defaultDirectoryMode(),
    }]);
  }
  return manifestFromEntries([...merged.values()].map(value => value.entry));
}

function mapSymlinkTarget(
  root: string,
  link: string,
  target: string,
  relocatedRootAliases: string[] = [],
): {
  linkTarget: string;
  targetRelativePath: string;
  rawTargetWasAbsolute: boolean;
  relocated: boolean;
} {
  const originalLexicalTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(path.dirname(link), target);
  let lexicalTarget = originalLexicalTarget;
  let relocated = false;
  if (!isStrictlyContained(root, lexicalTarget)) {
    const aliases = relocatedRootAliases.filter(candidate =>
      isStrictlyContained(candidate, originalLexicalTarget));
    if (aliases.length > 1) {
      throw new WorkspaceMigrationUnsafePathError(
        `Symlink target matches multiple managed relocation roots: ${link} -> ${target}`,
      );
    }
    if (aliases[0]) {
      lexicalTarget = path.join(root, path.relative(aliases[0], originalLexicalTarget));
      relocated = true;
    }
  }
  if (!isStrictlyContained(root, lexicalTarget)) {
    throw new WorkspaceMigrationUnsafePathError(`Symlink escapes its managed root: ${link} -> ${target}`);
  }
  const targetRelativePath = path.relative(root, lexicalTarget)
    .split(path.sep)
    .join('/');
  return {
    // Persist the direct mapped edge. Resolving to the canonical terminal would
    // silently flatten an intentional A -> B -> C package-manager link chain.
    linkTarget: path.relative(path.dirname(link), lexicalTarget) || '.',
    targetRelativePath,
    rawTargetWasAbsolute: path.isAbsolute(target),
    relocated,
  };
}

function decodeLinuxMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function parseLinuxMountPoints(contents: string): Set<string> {
  const mounts = new Set<string>();
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf(' - ');
    const fields = (separator >= 0 ? line.slice(0, separator) : line).split(' ');
    if (separator < 0 || fields.length < 6 || !fields[4]) {
      throw new WorkspaceMigrationUnsafePathError('Linux mount table is malformed; migration cannot inventory safely.');
    }
    const mountPoint = decodeLinuxMountInfoPath(fields[4]);
    if (!path.isAbsolute(mountPoint)) {
      throw new WorkspaceMigrationUnsafePathError(
        `Linux mount table contains a non-absolute mount point: ${mountPoint}`,
      );
    }
    mounts.add(path.resolve(mountPoint));
  }
  if (mounts.size === 0) {
    throw new WorkspaceMigrationUnsafePathError('Linux mount table is empty; migration cannot inventory safely.');
  }
  return mounts;
}

async function nestedLinuxMountPoints(canonicalRoot: string): Promise<Set<string>> {
  if (process.platform !== 'linux' && mountInfoForTests === undefined) return new Set();
  let contents: string;
  if (mountInfoForTests !== undefined) {
    contents = mountInfoForTests;
  } else {
    try {
      contents = await fs.readFile('/proc/self/mountinfo', 'utf8');
    } catch (error) {
      throw new WorkspaceMigrationUnsafePathError(
        `Cannot read /proc/self/mountinfo; migration cannot exclude nested bind mounts ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  const mounts = parseLinuxMountPoints(contents);
  return new Set([...mounts].filter(mount => isStrictlyContained(canonicalRoot, mount)));
}

/**
 * A managed tree may itself be a Docker volume/bind-mount root, but recursively
 * walking across another filesystem below that root is unsafe.  The later
 * archive/cleanup steps operate on whole trees; treating a nested mount as an
 * ordinary directory could therefore copy and then delete data owned by a
 * different mount.  `dev` catches normal POSIX volume transitions, while the
 * canonical-path comparison catches directory reparse points that Node reports
 * as directories rather than symbolic links on some Windows filesystems.
 */
async function assertSameManagedFilesystem(
  root: string,
  canonicalRoot: string,
  rootStat: Stats,
  candidate: string,
  relativePath: string,
  stat: Stats,
  nestedMountPoints: Set<string>,
): Promise<void> {
  if (!relativePath || stat.isSymbolicLink()) return;
  if (stat.dev !== rootStat.dev) {
    throw new WorkspaceMigrationUnsafePathError(
      `Managed data crosses a nested filesystem boundary: ${candidate} (root ${root})`,
    );
  }

  // A regular file cannot redirect traversal into another tree: file symlinks
  // were handled above, hardlinks are tracked separately, and every ancestor
  // directory is canonicalized here. Avoiding realpath() for every ordinary
  // payload file is a large fast-path win on Windows repositories/node_modules.
  if (stat.isFile()) return;

  const canonicalCandidate = await fs.realpath(candidate);
  const expectedCanonical = nativePath(canonicalRoot, relativePath);
  if (nestedMountPoints.has(path.resolve(canonicalCandidate))) {
    throw new WorkspaceMigrationUnsafePathError(
      `Managed data crosses a nested mount point: ${candidate} (root ${root})`,
    );
  }
  if (!samePath(canonicalCandidate, expectedCanonical)) {
    throw new WorkspaceMigrationUnsafePathError(
      `Managed data crosses a nested reparse boundary: ${candidate} -> ${canonicalCandidate}`,
    );
  }
}

async function buildManifest(
  root: string,
  relocatedRootAliases: string[] = [],
  purpose = 'inventory',
  options: {
    hashFileContents?: boolean;
    ignoredRelativePaths?: ReadonlySet<string>;
  } = {},
): Promise<PathManifest | undefined> {
  await assertManagedPathAncestors(root);
  const rootStat = await lstatOptional(root);
  if (!rootStat) return undefined;
  if (rootStat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Managed root must not be a symlink or junction: ${root}`);
  }
  const canonicalRoot = await fs.realpath(root);
  const nestedMountPoints = await nestedLinuxMountPoints(canonicalRoot);
  const entries: ManifestEntry[] = [];
  const hashFileContents = options.hashFileContents ?? true;
  const pendingLinks: Array<{
    entry: ManifestEntry;
    link: string;
    targetRelativePath: string;
    rawTargetWasAbsolute: boolean;
  }> = [];
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let files = 0;
  let directories = 0;
  let links = 0;
  let relocatedLinks = 0;
  const relocatedLinkPaths: string[] = [];
  const absoluteLinkPaths: string[] = [];
  const hardLinkedFilePaths: string[] = [];
  let bytes = 0;
  const reportProgress = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgressAt < MIGRATION_PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    migrationConsole(force ? 'inventory complete' : 'inventory progress', {
      purpose,
      root,
      content: hashFileContents ? 'sha256' : 'metadata-only',
      files,
      directories,
      links,
      relocatedLinks,
      bytes: formatMigrationBytes(bytes),
      _bytes: bytes,
      elapsed: formatMigrationDuration(startedAt),
    });
  };
  migrationConsole('inventory started', {
    purpose,
    root,
    content: hashFileContents ? 'sha256' : 'metadata-only',
    _bytes: 0,
  });
  const walk = async (candidate: string, relativePath: string): Promise<void> => {
    if (
      relativePath
      && options.ignoredRelativePaths?.has(manifestPathIdentity(relativePath))
    ) return;
    if (relativePath && FAST_LINK_ARTIFACT_NAME.test(path.basename(candidate))) {
      throw new WorkspaceMigrationUnsafePathError(
        `Reserved fast-migration artifact exists without its owning transaction: ${candidate}`,
      );
    }
    const stat = await fs.lstat(candidate) as Stats;
    await assertSameManagedFilesystem(
      root,
      canonicalRoot,
      rootStat,
      candidate,
      relativePath,
      stat,
      nestedMountPoints,
    );
    if (stat.isSymbolicLink()) {
      const linkTarget = await fs.readlink(candidate);
      const normalizedLink = mapSymlinkTarget(
        root,
        candidate,
        linkTarget,
        relocatedRootAliases,
      );
      const after = await fs.lstat(candidate) as Stats;
      if (!after.isSymbolicLink() || !sameFileIdentity(stat, after) || await fs.readlink(candidate) !== linkTarget) {
        throw new Error(`Workspace migration symlink changed while it was inventoried: ${candidate}`);
      }
      const entry: ManifestEntry = {
        relativePath,
        type: 'symlink',
        linkTarget: normalizedLink.linkTarget,
      };
      entries.push(entry);
      pendingLinks.push({
        entry,
        link: candidate,
        targetRelativePath: normalizedLink.targetRelativePath,
        rawTargetWasAbsolute: normalizedLink.rawTargetWasAbsolute,
      });
      links += 1;
      if (normalizedLink.relocated) relocatedLinks += 1;
      if (normalizedLink.relocated) relocatedLinkPaths.push(relativePath);
      if (normalizedLink.rawTargetWasAbsolute) absoluteLinkPaths.push(relativePath);
      reportProgress();
      return;
    }
    if (stat.isFile()) {
      files += 1;
      if (hashFileContents) {
        if (stat.nlink > 1) hardLinkedFilePaths.push(relativePath);
        entries.push({
          relativePath,
          type: 'file',
          ...await hashFile(candidate, chunkBytes => {
            bytes += chunkBytes;
            reportProgress();
          }),
        });
      } else {
        const after = await fs.lstat(candidate) as Stats;
        if (
          !after.isFile()
          || after.isSymbolicLink()
          || !sameFileIdentity(stat, after)
          || permissionMode(after) !== permissionMode(stat)
          || after.size !== stat.size
          || after.mtimeMs !== stat.mtimeMs
          || after.ctimeMs !== stat.ctimeMs
          || after.nlink !== stat.nlink
        ) throw new Error(`Workspace migration file changed while it was inventoried: ${candidate}`);
        if (after.nlink > 1) hardLinkedFilePaths.push(relativePath);
        bytes += stat.size;
        entries.push({
          relativePath,
          type: 'file',
          mode: permissionMode(stat),
          size: stat.size,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs,
        });
      }
      reportProgress();
      return;
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceMigrationUnsafePathError(
        `Managed data contains an unsupported filesystem object: ${candidate}`,
      );
    }
    entries.push({ relativePath, type: 'directory', mode: permissionMode(stat) });
    directories += 1;
    reportProgress();
    const beforeEntries = (await fs.readdir(candidate, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const before = beforeEntries.map(entry => entry.name);
    const leafEntries = beforeEntries.filter(entry => !entry.isDirectory());
    const directoryEntries = beforeEntries.filter(entry => entry.isDirectory());
    for (let index = 0; index < leafEntries.length; index += FAST_INVENTORY_LEAF_CONCURRENCY) {
      await Promise.all(
        leafEntries
          .slice(index, index + FAST_INVENTORY_LEAF_CONCURRENCY)
          .map(entry => walk(
            path.join(candidate, entry.name),
            relativePath ? `${relativePath}/${entry.name}` : entry.name,
          )),
      );
    }
    // Recurse into real directories serially so a wide repository cannot create
    // an unbounded tree of pending promises. Leaf metadata still benefits from
    // bounded parallel I/O, which is where node_modules spends most of its time.
    for (const entry of directoryEntries) {
      await walk(
        path.join(candidate, entry.name),
        relativePath ? `${relativePath}/${entry.name}` : entry.name,
      );
    }
    const after = (await fs.readdir(candidate)).sort((a, b) => a.localeCompare(b));
    if (before.length !== after.length || before.some((name, index) => name !== after[index])) {
      throw new Error(`Workspace migration source changed while it was inventoried: ${candidate}`);
    }
    const afterStat = await fs.lstat(candidate) as Stats;
    if (
      !afterStat.isDirectory()
      || afterStat.isSymbolicLink()
      || !sameFileIdentity(stat, afterStat)
      || permissionMode(afterStat) !== permissionMode(stat)
      || afterStat.mtimeMs !== stat.mtimeMs
      || afterStat.ctimeMs !== stat.ctimeMs
    ) throw new Error(`Workspace migration directory changed while it was inventoried: ${candidate}`);
  };
  await walk(root, '');

  // Resolve links against the completed opaque inventory instead of asking the
  // OS to follow them. A renamed Windows junction chain still contains absolute
  // targets for the old root; logical resolution can safely remap every hop
  // without traversing stale or attacker-controlled filesystem paths.
  const entriesByPath = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    const identity = manifestPathIdentity(entry.relativePath);
    const prior = entriesByPath.get(identity);
    if (prior) {
      throw new WorkspaceMigrationUnsafePathError(
        `Managed data contains case-aliased paths: ${prior.relativePath} and ${entry.relativePath}`,
      );
    }
    entriesByPath.set(identity, entry);
  }
  const pendingByPath = new Map(
    pendingLinks.map(item => [manifestPathIdentity(item.entry.relativePath), item]),
  );
  const resolveLogicalTarget = (
    relativeTarget: string,
    origin: string,
    visited: Set<string> = new Set(),
  ): ManifestEntry => {
    const normalized = path.posix.normalize(relativeTarget);
    if (
      !normalized
      || normalized === '.'
      || normalized === '..'
      || normalized.startsWith('../')
      || path.posix.isAbsolute(normalized)
    ) {
      throw new WorkspaceMigrationUnsafePathError(
        `Symlink resolves outside its managed root: ${origin}`,
      );
    }
    const parts = normalized.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const candidateRelative = parts.slice(0, index + 1).join('/');
      const entry = entriesByPath.get(manifestPathIdentity(candidateRelative));
      if (!entry) {
        throw new WorkspaceMigrationUnsafePathError(
          `Broken or unreadable symlink is not allowed in managed data: ${origin} -> ${relativeTarget}`,
        );
      }
      if (entry.type === 'symlink') {
        const identity = manifestPathIdentity(entry.relativePath);
        if (visited.has(identity)) {
          throw new WorkspaceMigrationUnsafePathError(
            `Cyclic symlink is not allowed in managed data: ${origin} -> ${relativeTarget}`,
          );
        }
        const pending = pendingByPath.get(identity);
        if (!pending) throw new Error(`Missing pending symlink metadata for ${entry.relativePath}.`);
        const remainder = parts.slice(index + 1);
        const nextTarget = path.posix.normalize(
          path.posix.join(pending.targetRelativePath, ...remainder),
        );
        return resolveLogicalTarget(nextTarget, origin, new Set([...visited, identity]));
      }
      if (index < parts.length - 1 && entry.type !== 'directory') {
        throw new WorkspaceMigrationUnsafePathError(
          `Symlink traverses a non-directory target: ${origin} -> ${relativeTarget}`,
        );
      }
      if (index === parts.length - 1) return entry;
    }
    throw new WorkspaceMigrationUnsafePathError(`Broken symlink is not allowed in managed data: ${origin}`);
  };
  for (const pending of pendingLinks) {
    const terminal = resolveLogicalTarget(pending.targetRelativePath, pending.link);
    pending.entry.linkType = terminal.type === 'directory'
      ? process.platform === 'win32' && pending.rawTargetWasAbsolute ? 'junction' : 'directory'
      : 'file';
  }

  const manifest = {
    ...manifestFromEntries(entries),
    relocatedLinks,
    relocatedLinkPaths,
    absoluteLinkPaths,
    hardLinkedFilePaths,
  };
  reportProgress(true);
  return manifest;
}

async function requireDigest(
  candidate: string,
  digest: string,
  label: string,
  relocatedRootAliases: string[] = [],
): Promise<PathManifest> {
  const manifest = await buildManifest(candidate, relocatedRootAliases);
  if (!manifest || manifest.digest !== digest) {
    throw new WorkspaceMigrationConflictError(label, candidate, candidate, 'content changed during migration');
  }
  return manifest;
}

function backupPath(source: string, transactionId: string, destination = false): string {
  return path.join(
    path.dirname(source),
    `.${path.basename(source)}.workspace-v2-${transactionId}${destination ? '.destination' : ''}.bak`,
  );
}

function safeStageName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'entry'}-` +
    createHash('sha256').update(id).digest('hex').slice(0, 12);
}

function applicationSharesDataRoot(): boolean {
  const appRoot = path.resolve(process.env.FLUJO_APP_ROOT?.trim() || getAppDir());
  return samePath(appRoot, getDataDir());
}

function legacyBrowserUserdataRoot(): string {
  return path.join(getDataDir(), 'mcp-servers', 'browser', 'userdata');
}

function baseCandidates(): CandidateEntry[] {
  const dataRoot = getDataDir();
  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  const entries: CandidateEntry[] = [{
    id: 'db',
    subtree: 'db',
    sources: LEGACY_DB_CANDIDATES.map(parts => path.join(dataRoot, ...parts)),
    destination: path.join(workspaceRoot, 'db'),
    requireDirectory: true,
  }];

  for (const subtree of EXTRA_WORKSPACE_ROOTS) {
    const sources = [path.join(dataRoot, subtree)];
    if (
      applicationSharesDataRoot()
      && ['screenshots', 'recordings', 'browser-profile'].includes(subtree)
    ) {
      // Older shipped browser builds wrote beneath their package cwd. Preserve
      // the package itself but merge its runtime data into the modern roots.
      sources.push(path.join(legacyBrowserUserdataRoot(), subtree));
    }
    entries.push({
      id: subtree,
      subtree,
      sources,
      destination: path.join(workspaceRoot, subtree),
      requireDirectory: true,
    });
  }

  const sourceMcpRoot = path.join(dataRoot, 'mcp-servers');
  const destinationMcpRoot = path.join(workspaceRoot, 'mcp-servers');
  if (!applicationSharesDataRoot()) {
    entries.push({
      id: 'mcp-servers',
      subtree: 'mcp-servers',
      sources: [sourceMcpRoot],
      destination: destinationMcpRoot,
      requireDirectory: true,
    });
  }
  return entries;
}

function candidateForJournalId(id: string): CandidateEntry | undefined {
  const staticEntry = baseCandidates().find(candidate => candidate.id === id);
  if (staticEntry) return staticEntry;
  if (!applicationSharesDataRoot() || !id.startsWith('mcp-servers/')) return undefined;
  const name = id.slice('mcp-servers/'.length);
  if (
    !name
    || name === '.'
    || name === '..'
    || name.includes('\0')
    || path.basename(name) !== name
    || APP_OWNED_MCP_ENTRIES.has(name.toLowerCase())
    || TRANSACTION_BACKUP_NAME.test(name)
  ) return undefined;
  return {
    id,
    subtree: 'mcp-servers',
    sources: [path.join(getDataDir(), 'mcp-servers', name)],
    destination: path.join(getWorkspaceDir(DEFAULT_WORKSPACE), 'mcp-servers', name),
    requireDirectory: false,
  };
}

async function validateLegacyBrowserUserdataRoot(): Promise<void> {
  if (!applicationSharesDataRoot()) return;
  const root = legacyBrowserUserdataRoot();
  const stat = await lstatOptional(root);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`Legacy browser userdata root is unsafe: ${root}`);
  }
  const supported = new Set(['screenshots', 'recordings', 'browser-profile']);
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (TRANSACTION_BACKUP_NAME.test(entry.name)) {
      throw new WorkspaceMigrationUnsafePathError(
        `Orphaned workspace migration backup requires recovery before startup: ${path.join(root, entry.name)}`,
      );
    }
    if (!supported.has(entry.name)) {
      throw new WorkspaceMigrationUnsafePathError(
        `Unrecognized legacy browser runtime data cannot be mapped safely: ${path.join(root, entry.name)}`,
      );
    }
  }
}

async function discoverCandidates(): Promise<CandidateEntry[]> {
  const dataRoot = getDataDir();
  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  const entries = baseCandidates();

  if (applicationSharesDataRoot()) {
    await validateLegacyBrowserUserdataRoot();
    const sourceMcpRoot = path.join(dataRoot, 'mcp-servers');
    const destinationMcpRoot = path.join(workspaceRoot, 'mcp-servers');
    const stat = await lstatOptional(sourceMcpRoot);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new WorkspaceMigrationUnsafePathError(`Application MCP root is unsafe: ${sourceMcpRoot}`);
    }
    if (!stat) {
      const destinationStat = await lstatOptional(destinationMcpRoot);
      if (destinationStat?.isDirectory() && !destinationStat.isSymbolicLink()) {
        const misplaced = (await fs.readdir(destinationMcpRoot))
          .filter(name => APP_OWNED_MCP_ENTRIES.has(name.toLowerCase()));
        if (misplaced.length > 0) {
          throw new WorkspaceMigrationMarkerError(
            `Application-owned MCP packages are missing from ${sourceMcpRoot} and appear inside ` +
            `${destinationMcpRoot}: ${misplaced.join(', ')}. An older migration moved shipped ` +
            `application code. Restore or reinstall the application files before retrying; FLUJO ` +
            `will not execute workspace data as trusted shipped code.`,
          );
        }
      }
    }
    if (stat) {
      const dirents = await fs.readdir(sourceMcpRoot, { withFileTypes: true });
      const aliases = new Map<string, string[]>();
      for (const entry of dirents) {
        if (TRANSACTION_BACKUP_NAME.test(entry.name)) {
          throw new WorkspaceMigrationUnsafePathError(
            `Orphaned workspace migration backup requires recovery before startup: ` +
            path.join(sourceMcpRoot, entry.name),
          );
        }
        const folded = entry.name.toLowerCase();
        const group = aliases.get(folded) ?? [];
        group.push(entry.name);
        aliases.set(folded, group);
      }
      const collision = [...aliases.values()].find(group => group.length > 1);
      if (collision) {
        throw new WorkspaceMigrationUnsafePathError(`MCP entries have a case alias: ${collision.join(', ')}`);
      }
      for (const entry of dirents) {
        if (
          APP_OWNED_MCP_ENTRIES.has(entry.name.toLowerCase())
        ) continue;
        entries.push({
          id: `mcp-servers/${entry.name}`,
          subtree: 'mcp-servers',
          sources: [path.join(sourceMcpRoot, entry.name)],
          destination: path.join(destinationMcpRoot, entry.name),
          requireDirectory: false,
        });
      }
    }
  }

  const destinations = new Map<string, string>();
  for (const entry of entries) {
    const key = process.platform === 'win32'
      ? path.resolve(entry.destination).toLowerCase()
      : path.resolve(entry.destination);
    const prior = destinations.get(key);
    if (prior) {
      throw new WorkspaceMigrationUnsafePathError(
        `Migration entries ${prior} and ${entry.id} target the same destination.`,
      );
    }
    destinations.set(key, entry.id);
  }
  return entries;
}

function workspaceMcpFastCandidate(): CandidateEntry {
  return {
    id: FAST_WORKSPACE_MCP_ID,
    subtree: 'mcp-servers',
    sources: [],
    destination: path.join(getWorkspaceDir(DEFAULT_WORKSPACE), 'mcp-servers'),
    requireDirectory: true,
  };
}

function candidateForFastId(id: string): CandidateEntry | undefined {
  if (id === FAST_WORKSPACE_MCP_ID && applicationSharesDataRoot()) {
    return workspaceMcpFastCandidate();
  }
  return candidateForJournalId(id);
}

function isSafeRelativeEntryPath(value: unknown, allowRoot = false): value is string {
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
  ) return false;
  if (value === '') return allowRoot;
  return !value.split('/').some(part => part === '' || part === '.' || part === '..');
}

function rootIdentity(stat: BigIntStats): FastRootIdentity | undefined {
  const identity = {
    dev: stat.dev.toString(10),
    ino: stat.ino.toString(10),
    birthtimeNs: stat.birthtimeNs.toString(10),
  };
  return validRootIdentity(identity) ? identity : undefined;
}

function validRootIdentity(value: unknown): value is FastRootIdentity {
  const identity = value as Partial<FastRootIdentity> | undefined;
  return Boolean(
    identity
    && typeof identity.dev === 'string'
    && /^[1-9][0-9]*$/.test(identity.dev)
    && typeof identity.ino === 'string'
    && /^[1-9][0-9]*$/.test(identity.ino)
    && typeof identity.birthtimeNs === 'string'
    && /^[1-9][0-9]*$/.test(identity.birthtimeNs),
  );
}

function sameRootIdentity(stat: BigIntStats, expected: FastRootIdentity): boolean {
  return stat.dev.toString(10) === expected.dev
    && stat.ino.toString(10) === expected.ino
    && stat.birthtimeNs.toString(10) === expected.birthtimeNs;
}

async function assertFastDirectoryIdentity(
  candidate: string,
  expected: FastRootIdentity,
  label: string,
): Promise<BigIntStats> {
  const dataRoot = path.resolve(getDataDir());
  const resolved = path.resolve(candidate);
  if (!isContainedOrEqual(dataRoot, resolved)) {
    throw new WorkspaceMigrationUnsafePathError(`${label} escapes the FLUJO data root: ${candidate}`);
  }

  const dataRootStat = await lstatBigIntOptional(dataRoot);
  if (!dataRootStat?.isDirectory() || dataRootStat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`FLUJO data root changed during fast migration: ${dataRoot}`);
  }
  const canonicalDataRoot = await fs.realpath(dataRoot);
  if (!samePath(canonicalDataRoot, dataRoot)) {
    throw new WorkspaceMigrationUnsafePathError(`FLUJO data root resolves through a reparse point: ${dataRoot}`);
  }

  const relative = path.relative(dataRoot, resolved);
  let cursor = dataRoot;
  let cursorStat = dataRootStat;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await lstatBigIntOptional(cursor);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceMigrationUnsafePathError(`${label} has a non-directory or reparse ancestor: ${cursor}`);
    }
    if (stat.dev !== dataRootStat.dev || !samePath(await fs.realpath(cursor), cursor)) {
      throw new WorkspaceMigrationUnsafePathError(`${label} crosses a mount or reparse point: ${cursor}`);
    }
    cursorStat = stat;
  }
  if (!sameRootIdentity(cursorStat, expected)) {
    throw new WorkspaceMigrationConflictError(
      label,
      candidate,
      candidate,
      'directory identity changed after fast preflight',
    );
  }
  return cursorStat;
}

function fastLinkArtifactPath(
  candidate: CandidateEntry,
  transactionId: string,
  relativePath: string,
  kind: 'new' | 'old',
): string {
  const link = nativePath(candidate.destination, relativePath);
  const token = createHash('sha256')
    .update(`${candidate.id}\0${relativePath}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(
    path.dirname(link),
    `.flujo-workspace-${transactionId.slice(0, 8)}-${token}.${kind}`,
  );
}

function fastLinkTargetMatches(
  actual: string,
  expected: string,
  linkType: FastLinkPlan['linkType'],
): boolean {
  if (linkType === 'junction') {
    return path.isAbsolute(actual) && path.isAbsolute(expected) && samePath(actual, expected);
  }
  return actual === expected;
}

function validateFastLinkPlan(
  candidate: CandidateEntry,
  transactionId: string,
  value: unknown,
): asserts value is FastLinkPlan {
  const link = value as Partial<FastLinkPlan> | undefined;
  if (
    !link
    || !isSafeRelativeEntryPath(link.relativePath)
    || typeof link.oldTarget !== 'string'
    || link.oldTarget.includes('\0')
    || typeof link.newTarget !== 'string'
    || link.newTarget.includes('\0')
    || (
      link.linkType !== 'directory'
      && link.linkType !== 'junction'
    )
    || !validRootIdentity(link.linkIdentity)
    || !validRootIdentity(link.parentIdentity)
  ) {
    throw new WorkspaceMigrationMarkerError('Fast workspace migration journal contains invalid link metadata.');
  }

  const linkPath = nativePath(candidate.destination, link.relativePath);
  if (!isStrictlyContained(candidate.destination, linkPath)) {
    throw new WorkspaceMigrationMarkerError('Fast workspace migration journal link escapes its destination.');
  }
  let mapped: ReturnType<typeof mapSymlinkTarget>;
  try {
    mapped = mapSymlinkTarget(
      candidate.destination,
      linkPath,
      link.oldTarget,
      candidate.sources,
    );
  } catch (error) {
    throw new WorkspaceMigrationMarkerError(
      `Fast workspace migration journal contains an unsafe old link target: ${linkPath}`,
      { cause: error },
    );
  }
  if (!mapped.relocated) {
    throw new WorkspaceMigrationMarkerError(
      `Fast workspace migration journal link does not name a legacy root: ${linkPath}`,
    );
  }
  const expectedTarget = link.linkType === 'junction'
    ? path.resolve(path.dirname(linkPath), mapped.linkTarget)
    : mapped.linkTarget;
  if (!fastLinkTargetMatches(link.newTarget, expectedTarget, link.linkType)) {
    throw new WorkspaceMigrationMarkerError(
      `Fast workspace migration journal contains an invalid replacement target: ${linkPath}`,
    );
  }
  if (
    (link.linkType === 'junction' && !path.isAbsolute(link.newTarget))
    || (link.linkType !== 'junction' && path.isAbsolute(link.newTarget))
  ) {
    throw new WorkspaceMigrationMarkerError(
      `Fast workspace migration journal contains a non-portable replacement link: ${linkPath}`,
    );
  }

  const parent = path.dirname(linkPath);
  for (const kind of ['new', 'old'] as const) {
    const artifact = fastLinkArtifactPath(candidate, transactionId, link.relativePath, kind);
    if (!samePath(path.dirname(artifact), parent) || !isStrictlyContained(candidate.destination, artifact)) {
      throw new WorkspaceMigrationMarkerError('Fast workspace migration link artifact escapes its destination.');
    }
  }
}

function validateFastJournal(journal: FastMigrationJournal): void {
  if (
    !SUPPORTED_FAST_JOURNAL_SCHEMA_VERSIONS.has(journal.schemaVersion)
    || journal.targetVersion !== WORKSPACE_LAYOUT_VERSION
    || !Array.isArray(journal.entries)
    || !UUID_PATTERN.test(journal.transactionId)
    || typeof journal.createdAt !== 'string'
    || !Number.isFinite(Date.parse(journal.createdAt))
    || !FAST_JOURNAL_PHASES.has(journal.phase)
  ) {
    throw new WorkspaceMigrationMarkerError('Fast workspace migration journal has invalid lifecycle metadata.');
  }

  const required = baseCandidates().map(candidate => candidate.id);
  if (applicationSharesDataRoot()) required.push(FAST_WORKSPACE_MCP_ID);
  const expectedIds = new Set(required);
  const seenIds = new Set<string>();
  for (const entry of journal.entries) {
    if (
      !entry
      || typeof entry.id !== 'string'
      || seenIds.has(entry.id)
      || !expectedIds.has(entry.id)
    ) {
      throw new WorkspaceMigrationMarkerError('Fast workspace migration journal contains an unknown entry.');
    }
    seenIds.add(entry.id);
    const candidate = candidateForFastId(entry.id);
    if (
      !candidate
      || entry.subtree !== candidate.subtree
      || !['current', 'move'].includes(entry.action)
      || !SUBTREE_OUTCOMES.has(entry.outcome)
      || !Array.isArray(entry.links)
      || !isDigest(entry.structuralDigest, true)
      || !validRootIdentity(entry.destinationParentIdentity)
    ) {
      throw new WorkspaceMigrationMarkerError(
        `Fast workspace migration journal entry is invalid: ${entry.id}`,
      );
    }

    if (entry.action === 'move') {
      if (
        entry.outcome !== 'moved'
        || !Number.isSafeInteger(entry.sourceIndex)
        || (entry.sourceIndex ?? -1) < 0
        || (entry.sourceIndex ?? candidate.sources.length) >= candidate.sources.length
        || !validRootIdentity(entry.sourceIdentity)
        || !validRootIdentity(entry.sourceParentIdentity)
        || entry.destinationIdentity !== undefined
        || !entry.structuralDigest
        || entry.links.length !== 0
      ) {
        throw new WorkspaceMigrationMarkerError(
          `Fast workspace move entry is invalid: ${entry.id}`,
        );
      }
    } else if (
      entry.sourceIndex !== undefined
      || entry.sourceIdentity !== undefined
      || entry.sourceParentIdentity !== undefined
      || !['created', 'already-migrated'].includes(entry.outcome)
      || (entry.outcome === 'already-migrated' && (
        !validRootIdentity(entry.destinationIdentity)
        || !entry.structuralDigest
      ))
      || (entry.outcome === 'created' && !(
        (entry.destinationIdentity === undefined && entry.structuralDigest === undefined)
        || (validRootIdentity(entry.destinationIdentity) && Boolean(entry.structuralDigest))
      ))
    ) {
      throw new WorkspaceMigrationMarkerError(
        `Fast workspace current entry is invalid: ${entry.id}`,
      );
    }

    const seenLinks = new Set<string>();
    for (const link of entry.links) {
      validateFastLinkPlan(candidate, journal.transactionId, link);
      const identity = manifestPathIdentity(link.relativePath);
      if (seenLinks.has(identity)) {
        throw new WorkspaceMigrationMarkerError(
          `Fast workspace migration journal repeats a link: ${link.relativePath}`,
        );
      }
      seenLinks.add(identity);
    }
    if (entry.links.length > 0 && entry.action !== 'current') {
      throw new WorkspaceMigrationMarkerError(`Fast workspace move unexpectedly contains link repairs: ${entry.id}`);
    }
    if (
      ['marker', 'cleanup', 'committed'].includes(journal.phase)
      && entry.action === 'current'
      && (!validRootIdentity(entry.destinationIdentity) || !entry.structuralDigest)
    ) {
      throw new WorkspaceMigrationMarkerError(`Fast workspace entry was not durably bound: ${entry.id}`);
    }
  }
  if (seenIds.size !== expectedIds.size || required.some(id => !seenIds.has(id))) {
    throw new WorkspaceMigrationMarkerError('Fast workspace migration journal is missing a required entry.');
  }
}

function fastJournalDigest(journal: FastMigrationJournal): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: journal.schemaVersion,
    targetVersion: journal.targetVersion,
    transactionId: journal.transactionId,
    createdAt: journal.createdAt,
    entries: journal.entries,
  })).digest('hex');
}

async function filesystemRootIsMount(candidate: string): Promise<boolean> {
  if (process.platform !== 'linux' && mountInfoForTests === undefined) return false;
  let contents: string;
  if (mountInfoForTests !== undefined) {
    contents = mountInfoForTests;
  } else {
    try {
      contents = await fs.readFile('/proc/self/mountinfo', 'utf8');
    } catch (error) {
      throw new WorkspaceMigrationUnsafePathError(
        `Cannot read /proc/self/mountinfo while checking fast-move eligibility ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  const canonical = await fs.realpath(candidate);
  return parseLinuxMountPoints(contents).has(path.resolve(canonical));
}

async function planFastLinkRepairs(
  candidate: CandidateEntry,
  manifest: PathManifest,
  transactionId: string,
): Promise<FastLinkPlan[] | undefined> {
  if (manifest.relocatedLinkPaths.length > 0 && process.platform !== 'win32') return undefined;
  const entries = new Map(
    manifest.entries.map(entry => [manifestPathIdentity(entry.relativePath), entry]),
  );
  const plans: FastLinkPlan[] = [];
  for (const relativePath of manifest.relocatedLinkPaths) {
    const entry = entries.get(manifestPathIdentity(relativePath));
    if (
      !entry
      || entry.type !== 'symlink'
      || !entry.linkTarget
      || !entry.linkType
    ) throw new Error(`Missing relocated link metadata for ${relativePath}.`);
    // The fast journal deliberately models only directory links/junctions.
    // File-link repair uses the content-verified republish transaction.
    if (entry.linkType === 'file') return undefined;
    const link = nativePath(candidate.destination, relativePath);
    const oldTarget = await readFastLinkTarget(link, 'Fast preflight workspace link');
    if (oldTarget === undefined) return undefined;
    const linkStat = await lstatBigIntOptional(link);
    const linkIdentity = linkStat && rootIdentity(linkStat);
    if (
      !linkStat?.isSymbolicLink()
      || !linkIdentity
      || await fs.readlink(link) !== oldTarget
    ) return undefined;
    const mapped = mapSymlinkTarget(candidate.destination, link, oldTarget, candidate.sources);
    if (!mapped.relocated || mapped.linkTarget !== entry.linkTarget) {
      throw new WorkspaceMigrationConflictError(
        candidate.subtree,
        link,
        candidate.destination,
        'workspace link changed after structural inventory',
      );
    }
    const newTarget = entry.linkType === 'junction'
      ? path.resolve(path.dirname(link), entry.linkTarget)
      : entry.linkTarget;
    const parent = path.dirname(link);
    const parentStat = await lstatBigIntOptional(parent);
    const parentIdentity = parentStat && rootIdentity(parentStat);
    if (!parentStat?.isDirectory() || parentStat.isSymbolicLink() || !parentIdentity) return undefined;
    await assertFastDirectoryIdentity(parent, parentIdentity, 'Fast migration link parent');
    const plan: FastLinkPlan = {
      relativePath,
      oldTarget,
      newTarget,
      linkType: entry.linkType,
      linkIdentity,
      parentIdentity,
    };
    validateFastLinkPlan(candidate, transactionId, plan);
    for (const kind of ['new', 'old'] as const) {
      const artifact = fastLinkArtifactPath(candidate, transactionId, relativePath, kind);
      if (await lstatOptional(artifact)) {
        throw new WorkspaceMigrationUnsafePathError(
          `Fast workspace migration artifact already exists before preflight: ${artifact}`,
        );
      }
    }
    plans.push(plan);
  }
  return plans;
}

async function planFastMigration(transactionId: string): Promise<FastMigrationJournal | undefined> {
  // Existing fault-injection tests intentionally exercise the heavyweight
  // stage/archive transaction. Production never installs this hook.
  if (faultHook) return undefined;

  const discovered = await discoverCandidates();
  if (applicationSharesDataRoot() && discovered.some(entry => entry.id.startsWith('mcp-servers/'))) {
    migrationConsole('fast path unavailable; using merge-safe migration', {
      reason: 'runtime MCP entries must be separated from shipped application packages',
    });
    return undefined;
  }
  const candidates = applicationSharesDataRoot()
    ? [...discovered, workspaceMcpFastCandidate()]
    : discovered;
  const entries: FastJournalEntry[] = [];
  migrationConsole('preflight started', {
    transactionId,
    candidates: candidates.length,
    strategy: 'metadata-only atomic moves',
  });

  for (const [candidateIndex, candidate] of candidates.entries()) {
    migrationConsole('preflight candidate', {
      position: `${candidateIndex + 1}/${candidates.length}`,
      subtree: candidate.subtree,
      sources: candidate.sources.length,
      destination: candidate.destination,
      strategy: 'metadata-only',
    });
    const sourceManifests = await Promise.all(candidate.sources.map(async source => ({
      source,
      manifest: await buildManifest(
        source,
        [],
        `fast preflight source for ${candidate.id}`,
        { hashFileContents: false },
      ),
    })));
    const destinationManifest = await buildManifest(
      candidate.destination,
      candidate.sources,
      `fast preflight destination for ${candidate.id}`,
      { hashFileContents: false },
    );
    const destinationParent = path.dirname(candidate.destination);
    const destinationParentStat = await lstatBigIntOptional(destinationParent);
    const destinationParentIdentity = destinationParentStat && rootIdentity(destinationParentStat);
    if (
      !destinationParentStat?.isDirectory()
      || destinationParentStat.isSymbolicLink()
      || !destinationParentIdentity
    ) {
      migrationConsole('fast path unavailable; using merge-safe migration', {
        subtree: candidate.subtree,
        reason: 'destination parent has no stable filesystem identity',
      });
      return undefined;
    }
    await assertFastDirectoryIdentity(
      destinationParent,
      destinationParentIdentity,
      `Fast migration destination parent for ${candidate.id}`,
    );

    if (candidate.requireDirectory) {
      for (const source of sourceManifests) {
        if (source.manifest && source.manifest.entries[0]?.type !== 'directory') {
          throw new WorkspaceMigrationUnsafePathError(
            `Legacy ${candidate.subtree} root is not a directory: ${source.source}`,
          );
        }
      }
      if (destinationManifest && destinationManifest.entries[0]?.type !== 'directory') {
        throw new WorkspaceMigrationConflictError(
          candidate.subtree,
          candidate.sources.join(', '),
          candidate.destination,
          'workspace destination is not a directory',
        );
      }
    }

    const presentSources = sourceManifests
      .map((item, sourceIndex) => ({ ...item, sourceIndex }))
      .filter((item): item is typeof item & { manifest: PathManifest } => Boolean(item.manifest));
    if (presentSources.length === 0) {
      if (destinationManifest?.hardLinkedFilePaths.length) {
        migrationConsole('fast path unavailable; using merge-safe migration', {
          subtree: candidate.subtree,
          reason: 'workspace destination contains hard links that must be isolated',
        });
        return undefined;
      }
      const links = destinationManifest
        ? await planFastLinkRepairs(candidate, destinationManifest, transactionId)
        : [];
      if (links === undefined) {
        migrationConsole('fast path unavailable; using merge-safe migration', {
          subtree: candidate.subtree,
          reason: 'link parent has no stable filesystem identity',
        });
        return undefined;
      }
      const destinationStat = destinationManifest
        ? await lstatBigIntOptional(candidate.destination)
        : undefined;
      const destinationIdentity = destinationStat && rootIdentity(destinationStat);
      if (destinationManifest && (
        !destinationStat?.isDirectory()
        || destinationStat.isSymbolicLink()
        || !destinationIdentity
      )) {
        migrationConsole('fast path unavailable; using merge-safe migration', {
          subtree: candidate.subtree,
          reason: 'workspace destination has no stable filesystem identity',
        });
        return undefined;
      }
      if (destinationIdentity) {
        await assertFastDirectoryIdentity(
          candidate.destination,
          destinationIdentity,
          `Fast migration destination for ${candidate.id}`,
        );
      }
      entries.push({
        id: candidate.id,
        subtree: candidate.subtree,
        action: 'current',
        destinationIdentity,
        destinationParentIdentity,
        structuralDigest: destinationManifest?.digest,
        links,
        outcome: destinationManifest ? 'already-migrated' : 'created',
      });
      migrationConsole('preflight candidate ready', {
        position: `${candidateIndex + 1}/${candidates.length}`,
        subtree: candidate.subtree,
        outcome: destinationManifest ? 'already-migrated' : 'created',
        strategy: links.length > 0 ? 'targeted link repair' : 'already current',
        entries: destinationManifest?.entries.length ?? 0,
        linksToRelocate: links.length || undefined,
      });
      continue;
    }

    const movable = presentSources.length === 1
      && !destinationManifest
      && presentSources[0].manifest.entries[0]?.type === 'directory'
      && presentSources[0].manifest.absoluteLinkPaths.length === 0
      && presentSources[0].manifest.hardLinkedFilePaths.length === 0;
    if (!movable) {
      migrationConsole('fast path unavailable; using merge-safe migration', {
        subtree: candidate.subtree,
        reason: destinationManifest
          ? 'legacy and workspace trees must be reconciled'
          : presentSources.length > 1
            ? 'multiple legacy roots must be merged'
            : 'root type, absolute links, or hard links require republishing',
      });
      return undefined;
    }

    const source = presentSources[0];
    const [sourceStat, sourceParentStat] = await Promise.all([
      fs.lstat(source.source, { bigint: true }) as Promise<BigIntStats>,
      fs.lstat(path.dirname(source.source), { bigint: true }) as Promise<BigIntStats>,
    ]);
    const sourceIdentity = rootIdentity(sourceStat);
    const sourceParentIdentity = rootIdentity(sourceParentStat);
    if (
      !sourceStat.isDirectory()
      || sourceStat.isSymbolicLink()
      || !sourceParentStat.isDirectory()
      || sourceParentStat.isSymbolicLink()
      || !sourceIdentity
      || !sourceParentIdentity
      || sourceStat.dev !== destinationParentStat.dev
      // Windows uses a handle-bound native move and Linux uses
      // renameat2(RENAME_NOREPLACE); other platforms stay on the conservative
      // content-verified transaction.
      || !['win32', 'linux'].includes(process.platform)
      || await filesystemRootIsMount(source.source)
    ) {
      migrationConsole('fast path unavailable; using merge-safe migration', {
        subtree: candidate.subtree,
        reason: 'source cannot be atomically renamed on the destination filesystem',
      });
      return undefined;
    }
    await Promise.all([
      assertFastDirectoryIdentity(
        source.source,
        sourceIdentity,
        `Fast migration source for ${candidate.id}`,
      ),
      assertFastDirectoryIdentity(
        path.dirname(source.source),
        sourceParentIdentity,
        `Fast migration source parent for ${candidate.id}`,
      ),
    ]);
    entries.push({
      id: candidate.id,
      subtree: candidate.subtree,
      action: 'move',
      sourceIndex: source.sourceIndex,
      sourceIdentity,
      sourceParentIdentity,
      destinationParentIdentity,
      structuralDigest: source.manifest.digest,
      links: [],
      outcome: 'moved',
    });
    migrationConsole('preflight candidate ready', {
      position: `${candidateIndex + 1}/${candidates.length}`,
      subtree: candidate.subtree,
      outcome: 'moved',
      strategy: 'atomic directory rename',
      entries: source.manifest.entries.length,
    });
  }

  const journal: FastMigrationJournal = {
    schemaVersion: FAST_JOURNAL_SCHEMA_VERSION,
    targetVersion: WORKSPACE_LAYOUT_VERSION,
    transactionId,
    createdAt: new Date().toISOString(),
    phase: 'planned',
    entries,
  };
  validateFastJournal(journal);
  migrationConsole('preflight complete', {
    transactionId,
    entries: entries.length,
    strategy: 'metadata-only atomic moves',
  });
  return journal;
}

async function preflight(transactionId: string): Promise<MigrationJournal> {
  const candidates = await discoverCandidates();
  const transactionRoot = path.join(transactionsPath(), transactionId);
  const entries: JournalEntry[] = [];

  migrationConsole('preflight started', {
    transactionId,
    candidates: candidates.length,
  });

  // Inventory every source and destination before the first user-data rename.
  for (const [candidateIndex, candidate] of candidates.entries()) {
    migrationConsole('preflight candidate', {
      position: `${candidateIndex + 1}/${candidates.length}`,
      subtree: candidate.subtree,
      sources: candidate.sources.length,
      destination: candidate.destination,
    });
    const sourceManifests = await Promise.all(candidate.sources.map(async source => ({
      source,
      manifest: await buildManifest(source, [], `preflight source for ${candidate.id}`),
    })));
    const destinationManifest = await buildManifest(
      candidate.destination,
      candidate.sources,
      `preflight destination for ${candidate.id}`,
    );
    if (candidate.requireDirectory) {
      for (const source of sourceManifests) {
        if (source.manifest && source.manifest.entries[0]?.type !== 'directory') {
          throw new WorkspaceMigrationUnsafePathError(
            `Legacy ${candidate.subtree} root is not a directory: ${source.source}`,
          );
        }
      }
      if (destinationManifest && destinationManifest.entries[0]?.type !== 'directory') {
        throw new WorkspaceMigrationConflictError(
          candidate.subtree,
          candidate.sources.join(', '),
          candidate.destination,
          'workspace destination is not a directory',
        );
      }
    }

    const mergeInputs = sourceManifests
      .filter((item): item is { source: string; manifest: PathManifest } => Boolean(item.manifest))
      .map(item => ({ label: item.source, manifest: item.manifest }));
    if (destinationManifest) {
      mergeInputs.push({ label: candidate.destination, manifest: destinationManifest });
    }
    const merged = mergeManifests(mergeInputs, candidate.subtree, candidate.destination);
    const populatedSources = sourceManifests.filter(item => item.manifest && !item.manifest.emptyDirectory);
    const forceRepublish = Boolean(destinationManifest?.hardLinkedFilePaths.length);
    let outcome: SubtreeOutcome;
    if (sourceManifests.every(item => !item.manifest)) {
      outcome = destinationManifest ? (forceRepublish ? 'copied' : 'already-migrated') : 'created';
    } else if (destinationManifest?.digest === merged.digest) {
      outcome = populatedSources.length > 0 ? 'recovered-identical' : 'already-migrated';
    } else if (destinationManifest && !destinationManifest.emptyDirectory) {
      outcome = 'reconciled';
    } else {
      outcome = 'copied';
    }

    entries.push({
      id: candidate.id,
      subtree: candidate.subtree,
      sources: sourceManifests.map(item => ({
        path: item.source,
        backup: backupPath(item.source, transactionId),
        initialDigest: item.manifest?.digest,
      })),
      destination: candidate.destination,
      destinationBackup: backupPath(candidate.destination, transactionId, true),
      initialDestinationDigest: destinationManifest?.digest,
      destinationLinksToRelocate: destinationManifest?.relocatedLinks || undefined,
      forceRepublish,
      stage: path.join(transactionRoot, 'stage', safeStageName(candidate.id)),
      expectedDigest: merged.digest,
      expectedEntries: merged.entries,
      state: 'planned',
      outcome,
      requireDirectory: candidate.requireDirectory,
    });
    migrationConsole('preflight candidate ready', {
      position: `${candidateIndex + 1}/${candidates.length}`,
      subtree: candidate.subtree,
      outcome,
      entries: merged.entries.length,
      linksToRelocate: destinationManifest?.relocatedLinks || undefined,
    });
  }

  migrationConsole('preflight complete', { transactionId, entries: entries.length });

  const journal: MigrationJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    targetVersion: WORKSPACE_LAYOUT_VERSION,
    transactionId,
    createdAt: new Date().toISOString(),
    phase: 'planned',
    entries,
  };
  validateJournalPaths(journal);
  return journal;
}

function nativePath(root: string, relativePath: string): string {
  return relativePath ? path.join(root, ...relativePath.split('/')) : root;
}

function rootMoveKind(manifest: PathManifest): NoReplaceMoveKind {
  const root = manifest.entries.find(entry => entry.relativePath === '');
  if (!root) throw new WorkspaceMigrationMarkerError('Workspace manifest has no root entry.');
  if (root.type === 'directory') return 'directory';
  if (root.type === 'symlink') return 'link';
  return 'file';
}

async function materializeManifest(
  destination: string,
  merged: PathManifest,
  inputs: Array<{ root: string; manifest: PathManifest }>,
  publishedDestination: string,
  subtree: string,
): Promise<void> {
  const records = inputs.map(input => ({
    root: input.root,
    entries: new Map(input.manifest.entries.map(entry => [entry.relativePath, entry])),
  }));
  const rootRecord = merged.entries.find(entry => entry.relativePath === '');
  if (!rootRecord) throw new Error('Merged workspace manifest has no root record.');
  const totalFiles = merged.entries.filter(entry => entry.type === 'file').length;
  const totalByteCount = merged.entries.reduce(
    (total, entry) => total + (entry.type === 'file' ? entry.size ?? 0 : 0),
    0,
  );
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let files = 0;
  let bytes = 0;
  const reportProgress = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgressAt < MIGRATION_PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    migrationConsole(force ? 'transfer complete' : 'transfer progress', {
      subtree,
      files,
      totalFiles,
      bytes: formatMigrationBytes(bytes),
      totalBytes: formatMigrationBytes(totalByteCount),
      _bytes: bytes,
      elapsed: formatMigrationDuration(startedAt),
    });
  };
  migrationConsole('transfer started', {
    subtree,
    files: 0,
    totalFiles,
    bytes: formatMigrationBytes(0),
    totalBytes: formatMigrationBytes(totalByteCount),
    _bytes: 0,
  });

  const copyRecord = async (entry: ManifestEntry): Promise<void> => {
    const source = records.find(record => record.entries.has(entry.relativePath));
    if (!source) throw new Error(`No migration input supplies ${entry.relativePath || '.'}.`);
    const from = nativePath(source.root, entry.relativePath);
    const to = nativePath(destination, entry.relativePath);
    if (entry.type === 'directory') {
      // Keep transaction-owned directories traversable while descendants are
      // populated. Their original modes are restored bottom-up afterwards.
      await fs.mkdir(to, { recursive: false, mode: 0o700 });
    } else if (entry.type === 'file') {
      await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
      await fs.chmod(to, entry.mode!);
      files += 1;
      bytes += entry.size ?? 0;
      reportProgress();
    } else {
      if (entry.linkType === 'junction') {
        const stagedTarget = path.resolve(path.dirname(to), entry.linkTarget!);
        if (!isStrictlyContained(destination, stagedTarget)) {
          throw new WorkspaceMigrationUnsafePathError(
            `Staged junction target escapes its managed root: ${to} -> ${entry.linkTarget}`,
          );
        }
        const publishedTarget = path.join(
          publishedDestination,
          path.relative(destination, stagedTarget),
        );
        // Junctions store an absolute target. Point directly at the final
        // workspace location so the subsequent atomic stage rename cannot
        // strand the link on the transient transaction directory.
        await fs.symlink(publishedTarget, to, 'junction');
      } else {
        await fs.symlink(entry.linkTarget!, to, entry.linkType === 'directory' ? 'dir' : 'file');
      }
    }
  };

  await copyRecord(rootRecord);
  const rest = merged.entries
    .filter(entry => entry.relativePath !== '')
    .sort((a, b) => {
      const depth = (value: string) => value.split('/').length;
      return depth(a.relativePath) - depth(b.relativePath)
        || a.relativePath.localeCompare(b.relativePath);
    });
  // Materialize links only after every real directory/file, so their logical
  // in-tree targets exist for semantic validation. We never traverse a link
  // while copying its entry.
  for (const entry of rest.filter(item => item.type !== 'symlink')) await copyRecord(entry);
  for (const entry of rest.filter(item => item.type === 'symlink')) await copyRecord(entry);
  const directories = merged.entries
    .filter(entry => entry.type === 'directory')
    .sort((a, b) => {
      const depth = (value: string) => value ? value.split('/').length : 0;
      return depth(b.relativePath) - depth(a.relativePath)
        || b.relativePath.localeCompare(a.relativePath);
    });
  for (const entry of directories) {
    await fs.chmod(nativePath(destination, entry.relativePath), entry.mode!);
  }
  await applyManifestFileTimes(destination, merged);
  reportProgress(true);
}

async function applyManifestFileTimes(root: string, manifest: PathManifest): Promise<void> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue;
    if (!Number.isFinite(entry.atimeMs) || !Number.isFinite(entry.mtimeMs)) {
      throw new WorkspaceMigrationMarkerError(
        `Workspace migration manifest is missing file timestamps: ${entry.relativePath}`,
      );
    }
    const file = nativePath(root, entry.relativePath);
    const before = await fs.lstat(file) as Stats;
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new WorkspaceMigrationUnsafePathError(`Expected a regular file while restoring timestamps: ${file}`);
    }
    let originalMode: number | undefined;
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      // Windows rejects futime on a read-only handle even for writable files.
      handle = await fs.open(file, fsConstants.O_RDWR | noFollow);
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      originalMode = before.mode;
      await fs.chmod(file, originalMode | 0o200);
      handle = await fs.open(file, fsConstants.O_RDWR | noFollow);
    }
    try {
      const opened = await handle.stat() as Stats;
      if (!opened.isFile() || !sameFileIdentity(before, opened)) {
        throw new WorkspaceMigrationUnsafePathError(`File changed or escaped while restoring timestamps: ${file}`);
      }
      await handle.utimes(entry.atimeMs! / 1_000, entry.mtimeMs! / 1_000);
    } finally {
      await handle.close();
      if (originalMode !== undefined) await fs.chmod(file, originalMode);
    }
  }
}

async function fsyncManifest(root: string, manifest: PathManifest): Promise<void> {
  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue;
    const file = nativePath(root, entry.relativePath);
    let originalMode: number | undefined;
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      // Windows' FlushFileBuffers rejects a read-only handle with EPERM.
      handle = await fs.open(file, 'r+');
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // copyFile can preserve a read-only mode. Temporarily make only the
      // transaction-owned staged copy writable, fsync it, then restore its mode.
      originalMode = (await fs.lstat(file)).mode;
      await fs.chmod(file, originalMode | 0o200);
      handle = await fs.open(file, 'r+');
    }
    try {
      await handle.sync();
    } finally {
      await handle.close();
      if (originalMode !== undefined) await fs.chmod(file, originalMode);
    }
  }
  // Persist every directory entry bottom-up. Syncing only the stage root does
  // not make a nested file name durable: each containing directory must reach
  // disk before the completion marker can safely be published.
  const directories = manifest.entries
    .filter(entry => entry.type === 'directory')
    .sort((a, b) => {
      const depth = (value: string) => value ? value.split('/').length : 0;
      return depth(b.relativePath) - depth(a.relativePath)
        || b.relativePath.localeCompare(a.relativePath);
    });
  for (const entry of directories) {
    await syncDirectory(nativePath(root, entry.relativePath));
  }
}

function destinationRelocationAliases(entry: JournalEntry): string[] {
  return entry.sources.map(source => source.path);
}

function destinationBackupRelocationAliases(entry: JournalEntry): string[] {
  return [entry.destination, ...destinationRelocationAliases(entry)];
}

function assertDestinationRelocationState(
  entry: JournalEntry,
  manifest: PathManifest,
  candidate: string,
  allowPublished: boolean,
): void {
  const planned = entry.destinationLinksToRelocate ?? 0;
  if (manifest.relocatedLinks === planned) return;
  if (allowPublished && planned > 0 && manifest.relocatedLinks === 0 && manifest.digest === entry.expectedDigest) {
    return;
  }
  throw new WorkspaceMigrationConflictError(
    entry.subtree,
    candidate,
    entry.destination,
    'workspace link relocation state changed after preflight',
  );
}

async function collectEntryInputs(entry: JournalEntry): Promise<{
  inputs: Array<{ root: string; manifest: PathManifest }>;
  destination?: PathManifest;
  destinationBackup?: PathManifest;
}> {
  const inputs: Array<{ root: string; manifest: PathManifest }> = [];
  for (const source of entry.sources) {
    const [original, backup] = await Promise.all([
      buildManifest(source.path),
      buildManifest(source.backup, [source.path]),
    ]);
    if (original && backup) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        source.path,
        source.backup,
        'both original source and transaction backup exist',
      );
    }
    const available = original ?? backup;
    if (source.initialDigest) {
      if (!available || available.digest !== source.initialDigest) {
        throw new WorkspaceMigrationConflictError(
          entry.subtree,
          source.path,
          entry.destination,
          'source/backup differs from its preflight manifest',
        );
      }
      inputs.push({ root: original ? source.path : source.backup, manifest: available });
    } else if (available) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        source.path,
        entry.destination,
        'a formerly missing source appeared during migration',
      );
    }
  }

  const [destination, destinationBackup] = await Promise.all([
    buildManifest(entry.destination, destinationRelocationAliases(entry)),
    buildManifest(entry.destinationBackup, destinationBackupRelocationAliases(entry)),
  ]);
  if (destinationBackup) {
    if (
      !entry.initialDestinationDigest
      || destinationBackup.digest !== entry.initialDestinationDigest
    ) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        entry.destinationBackup,
        entry.destination,
        'destination backup differs from preflight',
      );
    }
    if (
      destination
      && (destination.digest !== entry.expectedDigest || destination.relocatedLinks !== 0)
    ) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        entry.destinationBackup,
        entry.destination,
        'destination was recreated while its transaction backup exists',
      );
    }
    inputs.push({ root: entry.destinationBackup, manifest: destinationBackup });
  } else if (destination && destination.digest !== entry.expectedDigest) {
    if (!entry.initialDestinationDigest || destination.digest !== entry.initialDestinationDigest) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        entry.sources.map(source => source.path).join(', '),
        entry.destination,
        'destination changed after preflight',
      );
    }
    assertDestinationRelocationState(entry, destination, entry.destination, false);
    inputs.push({ root: entry.destination, manifest: destination });
  } else if (destination && destination.digest === entry.expectedDigest) {
    assertDestinationRelocationState(entry, destination, entry.destination, true);
    inputs.push({ root: entry.destination, manifest: destination });
  } else if (entry.initialDestinationDigest) {
    throw new WorkspaceMigrationConflictError(
      entry.subtree,
      entry.destinationBackup,
      entry.destination,
      'preflight destination disappeared without a transaction backup',
    );
  }
  return { inputs, destination, destinationBackup };
}

async function ensureStage(
  entry: JournalEntry,
  requireIndependentFiles = false,
): Promise<void> {
  let stage = await buildManifest(entry.stage, [entry.destination]);
  if (
    stage?.digest === entry.expectedDigest
    && (!requireIndependentFiles || stage.hardLinkedFilePaths.length === 0)
  ) return;
  if (stage) await fs.rm(entry.stage, { recursive: true, force: false });
  const { inputs } = await collectEntryInputs(entry);
  const expected = manifestFromEntries(entry.expectedEntries);
  const merged = mergeManifests(
    inputs.map(input => ({ label: input.root, manifest: input.manifest })),
    entry.subtree,
    entry.destination,
  );
  if (merged.digest !== entry.expectedDigest || expected.digest !== entry.expectedDigest) {
    throw new WorkspaceMigrationConflictError(
      entry.subtree,
      entry.sources.map(source => source.path).join(', '),
      entry.destination,
      'recoverable inputs no longer produce the preflight manifest',
    );
  }
  await fs.mkdir(path.dirname(entry.stage), { recursive: true });
  if (inputs.length === 0 && expected.emptyDirectory) {
    await fs.mkdir(entry.stage);
  } else {
    // Use the durable preflight metadata, not a recovery-time re-inventory:
    // source reads after a crash may have advanced atime.
    await materializeManifest(entry.stage, expected, inputs, entry.destination, entry.subtree);
  }
  stage = await requireDigest(entry.stage, entry.expectedDigest, entry.subtree, [entry.destination]);
  if (requireIndependentFiles && stage.hardLinkedFilePaths.length > 0) {
    throw new WorkspaceMigrationConflictError(
      entry.subtree,
      entry.stage,
      entry.destination,
      'recovery stage still contains hard links',
    );
  }
  await fsyncManifest(entry.stage, stage);
  await syncDirectory(path.dirname(entry.stage));
}

async function archiveSources(entry: JournalEntry): Promise<void> {
  for (const source of entry.sources) {
    const [original, backup] = await Promise.all([
      buildManifest(source.path),
      buildManifest(source.backup, [source.path]),
    ]);
    if (!source.initialDigest) {
      if (original || backup) {
        throw new WorkspaceMigrationConflictError(
          entry.subtree,
          source.path,
          entry.destination,
          'a missing source appeared during commit',
        );
      }
      continue;
    }
    if (original && backup) {
      throw new WorkspaceMigrationConflictError(entry.subtree, source.path, source.backup);
    }
    if (source.retainedMount) {
      if (
        backup
        || !original
        || original.digest !== source.initialDigest
        || !validateRetainedManifest(source.retainedEntries, source.initialDigest)
      ) {
        throw new WorkspaceMigrationConflictError(
          entry.subtree,
          source.path,
          entry.destination,
          'retained mount source differs from its preflight inventory',
        );
      }
      continue;
    }
    if (backup) {
      if (backup.digest !== source.initialDigest) {
        throw new WorkspaceMigrationConflictError(entry.subtree, source.path, source.backup);
      }
      continue;
    }
    if (!original || original.digest !== source.initialDigest) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        source.path,
        entry.destination,
        'source changed before it could be archived',
      );
    }
    try {
      await moveNoReplaceWithRetry(
        source.path,
        source.backup,
        rootMoveKind(original),
      );
      await syncDirectory(path.dirname(source.path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EXDEV', 'EBUSY'].includes(code ?? '') || original.entries[0]?.type !== 'directory') {
        throw error;
      }
      // Docker/bind mount roots cannot be renamed out of their mount point.
      // Keep the verified source untouched through marker commit, then remove
      // only its inventoried children during the resumable cleanup phase.
      source.retainedMount = true;
      source.retainedEntries = original.entries;
      log.warn(`Workspace migration will retain and empty mount root ${source.path}`, { code });
    }
  }
}

function entryRequiresRepublish(entry: JournalEntry): boolean {
  return entry.forceRepublish === true && entry.state !== 'published';
}

async function archiveDestination(
  entry: JournalEntry,
  forceRepublish = false,
): Promise<void> {
  if (
    !entry.initialDestinationDigest
    || (
    entry.initialDestinationDigest === entry.expectedDigest
      && !forceRepublish
      && !entryRequiresRepublish(entry)
      && !entry.destinationLinksToRelocate
    )
  ) return;
  const [destination, backup] = await Promise.all([
    buildManifest(entry.destination, destinationRelocationAliases(entry)),
    buildManifest(entry.destinationBackup, destinationBackupRelocationAliases(entry)),
  ]);
  if (backup) {
    if (backup.digest !== entry.initialDestinationDigest) {
      throw new WorkspaceMigrationConflictError(entry.subtree, entry.destinationBackup, entry.destination);
    }
    if (
      destination
      && (
        destination.digest !== entry.expectedDigest
        || destination.relocatedLinks !== 0
        || (
          (forceRepublish || entryRequiresRepublish(entry))
          && destination.hardLinkedFilePaths.length > 0
        )
      )
    ) {
      throw new WorkspaceMigrationConflictError(entry.subtree, entry.destinationBackup, entry.destination);
    }
    return;
  }
  if (!destination || destination.digest !== entry.initialDestinationDigest) {
    if (destination?.digest === entry.expectedDigest && destination.relocatedLinks === 0) return;
    throw new WorkspaceMigrationConflictError(
      entry.subtree,
      entry.destination,
      entry.destination,
      'destination changed before publish',
    );
  }
  assertDestinationRelocationState(entry, destination, entry.destination, false);
  await moveNoReplaceWithRetry(
    entry.destination,
    entry.destinationBackup,
    rootMoveKind(destination),
  );
  await syncDirectory(path.dirname(entry.destination));
}

async function publishEntry(
  entry: JournalEntry,
  forceRepublish = false,
): Promise<void> {
  const destination = await buildManifest(entry.destination, destinationRelocationAliases(entry));
  if (
    destination?.digest === entry.expectedDigest
    && destination.relocatedLinks === 0
    && (
      (!forceRepublish && !entryRequiresRepublish(entry))
      || destination.hardLinkedFilePaths.length === 0
    )
  ) return;
  if (destination) {
    // An empty preflight destination is still archived instead of deleted so
    // every filesystem mutation remains recoverable until marker commit.
    if (entry.initialDestinationDigest !== destination.digest) {
      throw new WorkspaceMigrationConflictError(entry.subtree, entry.destination, entry.destination);
    }
    await archiveDestination(entry, forceRepublish);
  }
  const stage = await requireDigest(
    entry.stage,
    entry.expectedDigest,
    entry.subtree,
    [entry.destination],
  );
  await fs.mkdir(path.dirname(entry.destination), { recursive: true });
  try {
    await moveNoReplaceWithRetry(
      entry.stage,
      entry.destination,
      rootMoveKind(stage),
    );
  } catch (error) {
    const raced = await buildManifest(entry.destination, destinationRelocationAliases(entry));
    if (
      !raced
      || raced.digest !== entry.expectedDigest
      || raced.relocatedLinks !== 0
      || raced.hardLinkedFilePaths.length > 0
    ) throw error;
  }
  await syncDirectory(path.dirname(entry.destination));
  const published = await requireDigest(entry.destination, entry.expectedDigest, entry.subtree);
  if (published.hardLinkedFilePaths.length > 0) {
    throw new WorkspaceMigrationConflictError(
      entry.subtree,
      entry.destination,
      entry.destination,
      'republished destination still contains hard links',
    );
  }
}

async function executeEntry(entry: JournalEntry, journal: MigrationJournal): Promise<void> {
  const currentDestination = await buildManifest(
    entry.destination,
    destinationRelocationAliases(entry),
  );
  if (
    entryRequiresRepublish(entry)
    || currentDestination?.digest !== entry.expectedDigest
    || currentDestination.relocatedLinks > 0
  ) {
    await ensureStage(entry);
    entry.state = 'staged';
    await writeJournal(journal);
    await checkpoint(`after-stage:${entry.id}`);
  }

  await archiveSources(entry);
  entry.state = 'sources-archived';
  await writeJournal(journal);
  await checkpoint(`after-archive:${entry.id}`);

  const afterSources = await buildManifest(
    entry.destination,
    destinationRelocationAliases(entry),
  );
  if (
    entryRequiresRepublish(entry)
    || afterSources?.digest !== entry.expectedDigest
    || afterSources.relocatedLinks > 0
  ) {
    await archiveDestination(entry);
    entry.state = 'destination-archived';
    await writeJournal(journal);
    await checkpoint(`after-destination-archive:${entry.id}`);
    await publishEntry(entry);
  }
  entry.state = 'published';
  await writeJournal(journal);
  await checkpoint(`after-publish:${entry.id}`);
}

/**
 * Schema 3 predates the durable `forceRepublish` bit. A schema-3 transaction
 * could therefore publish its marker while an already-current destination
 * still shared hard-link inodes with another tree. Keep the legacy journal and
 * marker digest byte-for-byte compatible, but use its existing stage and
 * destination-backup paths to republish independent files before cleanup.
 *
 * The entry state transitions make the repair restartable without adding a
 * schema-3 field: `staged` is persisted before the destination is archived,
 * and `destination-archived` before the independent stage is published.
 */
async function republishLegacyHardlinkedDestinations(
  journal: MigrationJournal,
): Promise<void> {
  if (journal.schemaVersion !== LEGACY_JOURNAL_SCHEMA_VERSION) return;

  for (const entry of journal.entries) {
    // Schema 3 could retain hard links only when it left an unchanged existing
    // destination in place. Merged outputs and link-relocation outputs were
    // already materialized file-by-file, so avoid another content scan of
    // large trees that are known to have been republished (notably userdata).
    if (
      !entry.initialDestinationDigest
      || entry.initialDestinationDigest !== entry.expectedDigest
      || Boolean(entry.destinationLinksToRelocate)
    ) continue;

    let [destination, destinationBackup] = await Promise.all([
      buildManifest(entry.destination, destinationRelocationAliases(entry)),
      buildManifest(entry.destinationBackup, destinationBackupRelocationAliases(entry)),
    ]);

    if (destination) {
      if (
        destination.digest !== entry.expectedDigest
        || destination.relocatedLinks !== 0
      ) {
        // The ordinary transaction recovery below owns non-published states.
        // A matching marker/cleanup path must never reinterpret changed data as
        // a hard-link-only repair.
        continue;
      }
      if (destination.hardLinkedFilePaths.length === 0) {
        if (
          ['staged', 'destination-archived'].includes(entry.state)
          && destinationBackup?.digest === entry.initialDestinationDigest
        ) {
          entry.state = 'published';
          await writeJournal(journal);
        }
        continue;
      }
    } else {
      const repairWasDurablyStarted = ['staged', 'destination-archived'].includes(entry.state);
      if (!repairWasDurablyStarted || !destinationBackup) continue;
    }

    if (destinationBackup) {
      if (destinationBackup.digest !== entry.initialDestinationDigest) {
        throw new WorkspaceMigrationConflictError(
          entry.subtree,
          entry.destinationBackup,
          entry.destination,
          'legacy hard-link recovery backup differs from the preflight destination',
        );
      }
      if (destination) {
        throw new WorkspaceMigrationConflictError(
          entry.subtree,
          entry.destinationBackup,
          entry.destination,
          'both the hard-linked destination and its recovery backup exist',
        );
      }
    }

    migrationConsole('legacy destination isolation repair started', {
      transactionId: journal.transactionId,
      subtree: entry.subtree,
      hardLinkedFiles: destination?.hardLinkedFilePaths.length
        ?? destinationBackup?.hardLinkedFilePaths.length
        ?? 0,
    });

    // At least one complete, content-verified input exists here. A matching
    // but hard-linked stage is rebuilt instead of being published as-is.
    await ensureStage(entry, true);
    entry.state = 'staged';
    await writeJournal(journal);
    await checkpoint(`after-stage:${entry.id}`);

    await archiveDestination(entry, true);
    entry.state = 'destination-archived';
    await writeJournal(journal);
    await checkpoint(`after-destination-archive:${entry.id}`);

    await publishEntry(entry, true);
    entry.state = 'published';
    await writeJournal(journal);
    await checkpoint(`after-publish:${entry.id}`);

    destination = await buildManifest(entry.destination, destinationRelocationAliases(entry));
    destinationBackup = await buildManifest(
      entry.destinationBackup,
      destinationBackupRelocationAliases(entry),
    );
    if (
      !destination
      || destination.digest !== entry.expectedDigest
      || destination.relocatedLinks !== 0
      || destination.hardLinkedFilePaths.length > 0
      || !destinationBackup
      || destinationBackup.digest !== entry.initialDestinationDigest
    ) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        entry.destinationBackup,
        entry.destination,
        'legacy hard-link isolation repair was not durably published',
      );
    }
  }
}

const OUTCOME_RANK: Record<SubtreeOutcome, number> = {
  skipped: 0,
  'already-migrated': 1,
  created: 2,
  'recovered-identical': 3,
  moved: 4,
  copied: 5,
  reconciled: 6,
};

function aggregateOutcomes(
  entries: Array<{ subtree: string; outcome: SubtreeOutcome }>,
): Record<string, SubtreeOutcome> {
  const result: Record<string, SubtreeOutcome> = {};
  for (const subtree of WORKSPACE_SUBTREES) result[subtree] = 'created';
  for (const entry of entries) {
    const prior = result[entry.subtree];
    if (!prior || OUTCOME_RANK[entry.outcome] > OUTCOME_RANK[prior]) result[entry.subtree] = entry.outcome;
  }
  return result;
}

function journalDigest(journal: MigrationJournal): string {
  const dataRoot = getDataDir();
  const workspaceRoot = getWorkspaceDir(DEFAULT_WORKSPACE);
  const entries = journal.entries.map(entry => {
    const legacyEntry = {
    id: entry.id,
    subtree: entry.subtree,
    sources: entry.sources.map(source => ({
      path: path.relative(dataRoot, source.path),
      backup: path.relative(dataRoot, source.backup),
      initialDigest: source.initialDigest,
      retainedMount: source.retainedMount,
      retainedEntries: source.retainedEntries,
    })),
    destination: path.relative(workspaceRoot, entry.destination),
    destinationBackup: path.relative(workspaceRoot, entry.destinationBackup),
    initialDestinationDigest: entry.initialDestinationDigest,
    destinationLinksToRelocate: entry.destinationLinksToRelocate,
    stage: path.relative(transactionsPath(), entry.stage),
    expectedDigest: entry.expectedDigest,
    expectedEntries: entry.expectedEntries,
    outcome: entry.outcome,
    requireDirectory: entry.requireDirectory,
    };
    return journal.schemaVersion === LEGACY_JOURNAL_SCHEMA_VERSION
      ? legacyEntry
      : { ...legacyEntry, forceRepublish: entry.forceRepublish };
  });
  const payload = journal.schemaVersion === LEGACY_JOURNAL_SCHEMA_VERSION
    ? entries
    : { schemaVersion: JOURNAL_SCHEMA_VERSION, entries };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function cleanupRetainedMountSource(
  source: JournalSource,
  subtree: string,
  destination: string,
): Promise<void> {
  if (!source.initialDigest || !validateRetainedManifest(source.retainedEntries, source.initialDigest)) {
    throw new WorkspaceMigrationMarkerError(`Retained mount metadata is invalid: ${source.path}`);
  }
  const rootStat = await lstatOptional(source.path);
  if (!rootStat) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkspaceMigrationConflictError(
      subtree,
      source.path,
      destination,
      'retained mount root is no longer a real directory',
    );
  }

  const entries = source.retainedEntries
    .filter(entry => entry.relativePath !== '')
    .sort((a, b) => {
      const depth = (value: string) => value.split('/').length;
      return depth(b.relativePath) - depth(a.relativePath)
        || b.relativePath.localeCompare(a.relativePath);
    });
  for (const expected of entries) {
    const candidate = nativePath(source.path, expected.relativePath);
    const stat = await lstatOptional(candidate);
    if (!stat) continue; // A prior cleanup attempt already removed it.
    if (expected.type === 'file') {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new WorkspaceMigrationConflictError(subtree, candidate, destination);
      }
      const actual = await hashFile(candidate);
      if (
        actual.mode !== expected.mode
        || actual.size !== expected.size
        || actual.sha256 !== expected.sha256
      ) {
        throw new WorkspaceMigrationConflictError(
          subtree,
          candidate,
          destination,
          'retained source file changed after marker commit',
        );
      }
      await fs.unlink(candidate);
      continue;
    }
    if (expected.type === 'symlink') {
      const actualTarget = stat.isSymbolicLink() ? await fs.readlink(candidate) : undefined;
      const normalizedTarget = actualTarget === undefined
        ? undefined
        : mapSymlinkTarget(source.path, candidate, actualTarget);
      if (
        !stat.isSymbolicLink()
        || normalizedTarget?.linkTarget !== expected.linkTarget
        || (
          expected.linkType === 'junction'
          && (!normalizedTarget?.rawTargetWasAbsolute || process.platform !== 'win32')
        )
      ) {
        throw new WorkspaceMigrationConflictError(subtree, candidate, destination);
      }
      await fs.unlink(candidate);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceMigrationConflictError(subtree, candidate, destination);
    }
    if (permissionMode(stat) !== expected.mode) {
      throw new WorkspaceMigrationConflictError(
        subtree,
        candidate,
        destination,
        'retained source directory permissions changed after marker commit',
      );
    }
    try {
      await fs.rmdir(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new WorkspaceMigrationConflictError(
          subtree,
          candidate,
          destination,
          'unrecognized data appeared in a retained mount during cleanup',
        );
      }
      throw error;
    }
  }
  const remaining = await fs.readdir(source.path);
  if (remaining.length > 0) {
    throw new WorkspaceMigrationConflictError(
      subtree,
      source.path,
      destination,
      'retained mount contains data that was not present at preflight',
    );
  }
  await syncDirectory(source.path);
}

async function removeTransactionArtifact(
  journal: MigrationJournal,
  candidate: string,
  expectedDigest: string,
  cleanupStarted: boolean | undefined,
  markCleanupStarted: () => void,
  subtree: string,
  destination: string,
  relocatedRootAliases: string[] = [],
): Promise<void> {
  const stat = await lstatOptional(candidate);
  if (!stat) return;
  await assertManagedPathAncestors(candidate);
  if (stat.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(
      `Transaction cleanup target became a symlink or junction: ${candidate}`,
    );
  }
  if (!cleanupStarted) {
    const manifest = await buildManifest(candidate, relocatedRootAliases);
    if (!manifest || manifest.digest !== expectedDigest) {
      throw new WorkspaceMigrationConflictError(subtree, candidate, destination);
    }
    // This intent is fsynced before the first recursive unlink. If power is
    // lost halfway through, the exact transaction-derived path can be resumed
    // without demanding the now-partial tree still have its original digest.
    markCleanupStarted();
    await writeJournal(journal);
  }
  await fs.rm(candidate, { recursive: true, force: false });
  await syncDirectory(path.dirname(candidate));
}

async function cleanupTransaction(journal: MigrationJournal): Promise<void> {
  migrationConsole('cleanup started', {
    transactionId: journal.transactionId,
    entries: journal.entries.length,
  });
  journal.phase = 'cleanup';
  await writeJournal(journal);
  for (const [entryIndex, entry] of journal.entries.entries()) {
    migrationConsole('cleanup entry', {
      transactionId: journal.transactionId,
      position: `${entryIndex + 1}/${journal.entries.length}`,
      subtree: entry.subtree,
      destination: entry.destination,
    });
    const destination = await requireDigest(entry.destination, entry.expectedDigest, entry.subtree);
    if (destination.hardLinkedFilePaths.length > 0) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        entry.destination,
        entry.destination,
        'hard links remain before transaction cleanup',
      );
    }
    const expected = manifestFromEntries(entry.expectedEntries);
    // requireDigest hashes file contents and can advance atime. Reapply both
    // timestamps after that final verification read, then durably flush the
    // metadata before deleting the last recoverable source/backup copy.
    await applyManifestFileTimes(entry.destination, expected);
    await fsyncManifest(entry.destination, expected);
    for (const source of entry.sources) {
      if (source.retainedMount) {
        await cleanupRetainedMountSource(source, entry.subtree, entry.destination);
        await writeJournal(journal);
        continue;
      }
      if (source.initialDigest) {
        await removeTransactionArtifact(
          journal,
          source.backup,
          source.initialDigest,
          source.cleanupStarted,
          () => { source.cleanupStarted = true; },
          entry.subtree,
          entry.destination,
          [source.path],
        );
      } else if (await lstatOptional(source.backup)) {
        throw new WorkspaceMigrationConflictError(entry.subtree, source.backup, entry.destination);
      }
    }
    if (entry.initialDestinationDigest) {
      await removeTransactionArtifact(
        journal,
        entry.destinationBackup,
        entry.initialDestinationDigest,
        entry.destinationBackupCleanupStarted,
        () => { entry.destinationBackupCleanupStarted = true; },
        entry.subtree,
        entry.destination,
        destinationBackupRelocationAliases(entry),
      );
    } else if (await lstatOptional(entry.destinationBackup)) {
      throw new WorkspaceMigrationConflictError(
        entry.subtree,
        entry.destinationBackup,
        entry.destination,
      );
    }
    await removeTransactionArtifact(
      journal,
      entry.stage,
      entry.expectedDigest,
      entry.stageCleanupStarted,
      () => { entry.stageCleanupStarted = true; },
      entry.subtree,
      entry.destination,
      [entry.destination],
    );
    await writeJournal(journal);
    await checkpoint(`after-cleanup:${entry.id}`);
  }
  if (applicationSharesDataRoot()) {
    try {
      // Known children were archived above. Remove only the now-empty legacy
      // runtime container; never recurse into the shipped browser package.
      await fs.rmdir(legacyBrowserUserdataRoot());
      await syncDirectory(path.dirname(legacyBrowserUserdataRoot()));
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )) throw error;
    }
  }
  journal.phase = 'committed';
  await writeJournal(journal);
  const transactionRoot = path.join(transactionsPath(), journal.transactionId);
  if (isStrictlyContained(transactionsPath(), transactionRoot)) {
    await fs.rm(transactionRoot, { recursive: true, force: true });
  }
  await fs.unlink(journalPath());
  await syncDirectory(getWorkspacesDir());
  migrationConsole('cleanup complete', { transactionId: journal.transactionId });
}

async function readFastLinkTarget(candidate: string, label: string): Promise<string | undefined> {
  const before = await lstatOptional(candidate);
  if (!before) return undefined;
  if (!before.isSymbolicLink()) {
    throw new WorkspaceMigrationUnsafePathError(`${label} is not a symlink or junction: ${candidate}`);
  }
  const target = await fs.readlink(candidate);
  const after = await fs.lstat(candidate) as Stats;
  if (
    !after.isSymbolicLink()
    || !sameFileIdentity(before, after)
    || await fs.readlink(candidate) !== target
  ) throw new Error(`Workspace migration link changed while it was inspected: ${candidate}`);
  return target;
}

async function requireFastLinkIdentity(
  candidate: string,
  expected: FastRootIdentity,
  label: string,
): Promise<void> {
  const stat = await lstatBigIntOptional(candidate);
  if (!stat?.isSymbolicLink() || !sameRootIdentity(stat, expected)) {
    throw new WorkspaceMigrationConflictError(
      label,
      candidate,
      candidate,
      'link identity changed after fast preflight',
    );
  }
}

async function createFastLink(
  target: string,
  linkType: FastLinkPlan['linkType'],
  candidate: string,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new WorkspaceMigrationMarkerError('Fast link repair requires Windows no-replace rename semantics.');
  }
  if (linkType === 'junction') {
    await fs.symlink(target, candidate, 'junction');
  } else {
    await fs.symlink(target, candidate, 'dir');
  }
}

async function assertFastLinkBindings(
  entry: FastJournalEntry,
  candidate: CandidateEntry,
  plan: FastLinkPlan,
): Promise<void> {
  if (!entry.destinationIdentity) {
    throw new WorkspaceMigrationMarkerError(`Fast link entry has no destination identity: ${entry.id}`);
  }
  await assertFastDirectoryIdentity(
    path.dirname(candidate.destination),
    entry.destinationParentIdentity,
    `Fast migration destination parent for ${entry.id}`,
  );
  await assertFastDirectoryIdentity(
    candidate.destination,
    entry.destinationIdentity,
    `Fast migration destination for ${entry.id}`,
  );
  await assertFastDirectoryIdentity(
    path.dirname(nativePath(candidate.destination, plan.relativePath)),
    plan.parentIdentity,
    `Fast migration link parent for ${entry.id}/${plan.relativePath}`,
  );
}

async function applyFastLinkPlan(
  entry: FastJournalEntry,
  candidate: CandidateEntry,
  journal: FastMigrationJournal,
  plan: FastLinkPlan,
): Promise<void> {
  const link = nativePath(candidate.destination, plan.relativePath);
  const replacement = fastLinkArtifactPath(candidate, journal.transactionId, plan.relativePath, 'new');
  const backup = fastLinkArtifactPath(candidate, journal.transactionId, plan.relativePath, 'old');
  const parent = path.dirname(link);
  await assertFastLinkBindings(entry, candidate, plan);

  const inspectedTargets = await Promise.all([
    readFastLinkTarget(link, 'Managed workspace link'),
    readFastLinkTarget(replacement, 'Fast migration replacement link'),
    readFastLinkTarget(backup, 'Fast migration backup link'),
  ]);
  let liveTarget = inspectedTargets[0];
  const replacementTarget = inspectedTargets[1];
  let backupTarget = inspectedTargets[2];
  if (replacementTarget !== undefined) {
    throw new WorkspaceMigrationConflictError(
      candidate.subtree,
      replacement,
      candidate.destination,
      'unexpected replacement artifact exists for a no-clobber link transaction',
    );
  }
  const liveIsOld = liveTarget !== undefined
    && fastLinkTargetMatches(liveTarget, plan.oldTarget, plan.linkType);
  const liveIsNew = liveTarget !== undefined
    && fastLinkTargetMatches(liveTarget, plan.newTarget, plan.linkType);
  if (liveTarget !== undefined && !liveIsOld && !liveIsNew) {
    throw new WorkspaceMigrationConflictError(
      candidate.subtree,
      link,
      candidate.destination,
      'workspace link changed after fast preflight',
    );
  }
  if (backupTarget !== undefined && !fastLinkTargetMatches(backupTarget, plan.oldTarget, plan.linkType)) {
    throw new WorkspaceMigrationConflictError(
      candidate.subtree,
      backup,
      candidate.destination,
      'transaction backup link has an unexpected target',
    );
  }

  if (liveIsOld) {
    if (backupTarget !== undefined) {
      throw new WorkspaceMigrationConflictError(
        candidate.subtree,
        link,
        candidate.destination,
        'both the original link and its transaction backup exist',
      );
    }
    await fastCheckpoint(`before-fast-link-backup:${candidate.id}:${plan.relativePath}`);
    try {
      await moveNoReplaceWithRetry(link, backup, 'link', async () => {
        await assertFastLinkBindings(entry, candidate, plan);
        await requireFastLinkIdentity(link, plan.linkIdentity, `Fast migration link for ${entry.id}`);
        const recheckedLive = await readFastLinkTarget(link, 'Managed workspace link');
        if (
          recheckedLive === undefined
          || !fastLinkTargetMatches(recheckedLive, plan.oldTarget, plan.linkType)
          || await lstatOptional(backup)
        ) {
          throw new WorkspaceMigrationConflictError(
            candidate.subtree,
            link,
            candidate.destination,
            'workspace link changed before its no-clobber replacement',
          );
        }
        await fastCheckpoint(`after-fast-link-backup-absence-check:${candidate.id}:${plan.relativePath}`);
      }, {
        sourceIdentity: plan.linkIdentity,
        destinationParentIdentity: plan.parentIdentity,
      });
    } catch (error) {
      if (await lstatOptional(backup)) {
        throw new WorkspaceMigrationConflictError(
          candidate.subtree,
          link,
          candidate.destination,
          'transaction backup appeared during atomic link archival',
        );
      }
      throw error;
    }
    await syncDirectory(parent);
    await requireFastLinkIdentity(backup, plan.linkIdentity, `Fast migration backup for ${entry.id}`);
    backupTarget = await readFastLinkTarget(backup, 'Fast migration backup link');
    if (backupTarget === undefined || !fastLinkTargetMatches(backupTarget, plan.oldTarget, plan.linkType)) {
      throw new Error(`Fast workspace backup link was not durably created: ${backup}`);
    }
    liveTarget = undefined;
    await fastCheckpoint(`after-fast-link-backup:${candidate.id}:${plan.relativePath}`);
  }

  if (liveTarget === undefined && backupTarget === undefined) {
    // Directory fsync is not guaranteed on Windows. If a power loss retains the
    // journal but rolls back both names, reconstruct the journal-authenticated
    // backup first; symlink creation is atomic and no-replace.
    await assertFastLinkBindings(entry, candidate, plan);
    await createFastLink(plan.oldTarget, plan.linkType, backup);
    await syncDirectory(parent);
    backupTarget = await readFastLinkTarget(backup, 'Reconstructed fast migration backup link');
    if (backupTarget === undefined || !fastLinkTargetMatches(backupTarget, plan.oldTarget, plan.linkType)) {
      throw new Error(`Fast workspace backup link was not reconstructed: ${backup}`);
    }
  }

  if (liveTarget === undefined) {
    await assertFastLinkBindings(entry, candidate, plan);
    if (await lstatOptional(link)) {
      throw new WorkspaceMigrationConflictError(
        candidate.subtree,
        link,
        candidate.destination,
        'a path appeared before no-clobber link publication',
      );
    }
    await createFastLink(plan.newTarget, plan.linkType, link);
    await syncDirectory(parent);
    liveTarget = await readFastLinkTarget(link, 'Published workspace link');
    if (liveTarget === undefined || !fastLinkTargetMatches(liveTarget, plan.newTarget, plan.linkType)) {
      throw new Error(`Fast workspace replacement link was not published: ${link}`);
    }
    await fastCheckpoint(`after-fast-link-publish:${candidate.id}:${plan.relativePath}`);
  }
}

async function renameFastDirectoryNoReplace(
  entry: FastJournalEntry,
  candidate: CandidateEntry,
  source: string,
): Promise<void> {
  if (!entry.sourceIdentity || !entry.sourceParentIdentity) {
    throw new WorkspaceMigrationMarkerError(`Fast workspace move entry is incomplete: ${entry.id}`);
  }
  await fastCheckpoint(`before-fast-move-rename:${entry.id}`);
  try {
    await moveNoReplaceWithRetry(source, candidate.destination, 'directory', async () => {
      // Every retry rebinds every lexical ancestor immediately before the OS
      // move. No retry may reuse paths checked before a transient failure.
      await assertFastDirectoryIdentity(
        path.dirname(source),
        entry.sourceParentIdentity!,
        `Fast migration source parent for ${entry.id}`,
      );
      await assertFastDirectoryIdentity(
        source,
        entry.sourceIdentity!,
        `Fast migration source for ${entry.id}`,
      );
      await assertFastDirectoryIdentity(
        path.dirname(candidate.destination),
        entry.destinationParentIdentity,
        `Fast migration destination parent for ${entry.id}`,
      );
      if (await lstatOptional(candidate.destination)) {
        throw new WorkspaceMigrationConflictError(
          candidate.subtree,
          source,
          candidate.destination,
          'a path appeared before the no-clobber directory move',
        );
      }
      await fastCheckpoint(`after-fast-move-destination-absence-check:${entry.id}`);
    }, {
      sourceIdentity: entry.sourceIdentity,
      destinationParentIdentity: entry.destinationParentIdentity,
    });
  } catch (error) {
    if (await lstatOptional(candidate.destination)) {
      throw new WorkspaceMigrationConflictError(
        candidate.subtree,
        source,
        candidate.destination,
        'destination appeared during the no-clobber directory move',
      );
    }
    throw error;
  }
}

async function executeFastMove(entry: FastJournalEntry, candidate: CandidateEntry): Promise<void> {
  if (
    entry.action !== 'move'
    || entry.sourceIndex === undefined
    || !entry.sourceIdentity
    || !entry.sourceParentIdentity
  ) throw new WorkspaceMigrationMarkerError(`Fast workspace move entry is incomplete: ${entry.id}`);
  const source = candidate.sources[entry.sourceIndex];
  await assertFastDirectoryIdentity(
    path.dirname(candidate.destination),
    entry.destinationParentIdentity,
    `Fast migration destination parent for ${entry.id}`,
  );
  await assertFastDirectoryIdentity(
    path.dirname(source),
    entry.sourceParentIdentity,
    `Fast migration source parent for ${entry.id}`,
  );
  const [sourceStat, destinationStat] = await Promise.all([
    lstatBigIntOptional(source),
    lstatBigIntOptional(candidate.destination),
  ]);
  if (sourceStat && destinationStat) {
    throw new WorkspaceMigrationConflictError(
      candidate.subtree,
      source,
      candidate.destination,
      'both source and destination exist during atomic move recovery',
    );
  }
  if (sourceStat) {
    await renameFastDirectoryNoReplace(entry, candidate, source);
    await Promise.all([
      syncDirectory(path.dirname(source)),
      syncDirectory(path.dirname(candidate.destination)),
    ]);
  }
  await assertFastDirectoryIdentity(
    candidate.destination,
    entry.sourceIdentity,
    `Published fast migration destination for ${entry.id}`,
  );
  await fastCheckpoint(`after-fast-move:${entry.id}`);
}

async function bindCreatedFastEntries(
  journal: FastMigrationJournal,
  recreatedAfterMarker: ReadonlySet<string> = new Set(),
): Promise<void> {
  let changed = false;
  for (const entry of journal.entries) {
    if (entry.action !== 'current' || entry.outcome !== 'created') continue;
    const candidate = candidateForFastId(entry.id);
    if (!candidate) throw new WorkspaceMigrationMarkerError(`Unknown fast workspace entry: ${entry.id}`);
    await assertFastDirectoryIdentity(
      path.dirname(candidate.destination),
      entry.destinationParentIdentity,
      `Fast migration destination parent for ${entry.id}`,
    );
    if (entry.destinationIdentity && entry.structuralDigest) {
      if (recreatedAfterMarker.has(entry.id)) continue;
      await assertFastDirectoryIdentity(
        candidate.destination,
        entry.destinationIdentity,
        `Created fast migration destination for ${entry.id}`,
      );
      continue;
    }
    const manifest = await buildManifest(
      candidate.destination,
      candidate.sources,
      `binding newly-created destination for ${entry.id}`,
      { hashFileContents: false },
    );
    if (
      !manifest
      || manifest.entries.length !== 1
      || manifest.entries[0]?.type !== 'directory'
      || manifest.hardLinkedFilePaths.length !== 0
      || manifest.relocatedLinks !== 0
    ) {
      throw new WorkspaceMigrationConflictError(
        candidate.subtree,
        candidate.destination,
        candidate.destination,
        'new workspace directory gained data before it could be bound to the transaction',
      );
    }
    const stat = await lstatBigIntOptional(candidate.destination);
    const identity = stat && rootIdentity(stat);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || !identity) {
      throw new WorkspaceMigrationUnsafePathError(
        `New workspace directory has no stable filesystem identity: ${candidate.destination}`,
      );
    }
    await assertFastDirectoryIdentity(
      candidate.destination,
      identity,
      `Created fast migration destination for ${entry.id}`,
    );
    entry.destinationIdentity = identity;
    entry.structuralDigest = manifest.digest;
    changed = true;
  }
  if (changed) await writeFastJournal(journal);
}

async function validateFastPublishedLayout(
  journal: FastMigrationJournal,
  recreatedAfterMarker: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const entry of journal.entries) {
    const candidate = candidateForFastId(entry.id);
    if (!candidate) throw new WorkspaceMigrationMarkerError(`Unknown fast workspace entry: ${entry.id}`);
    const expectedIdentity = entry.action === 'move'
      ? entry.sourceIdentity
      : entry.destinationIdentity;
    if (!expectedIdentity || !entry.structuralDigest) {
      throw new WorkspaceMigrationMarkerError(`Fast workspace entry was not bound before validation: ${entry.id}`);
    }
    await assertFastDirectoryIdentity(
      path.dirname(candidate.destination),
      entry.destinationParentIdentity,
      `Fast migration destination parent for ${entry.id}`,
    );
    if (entry.outcome === 'created' && recreatedAfterMarker.has(entry.id)) {
      const recreatedStat = await lstatBigIntOptional(candidate.destination);
      const recreatedIdentity = recreatedStat && rootIdentity(recreatedStat);
      if (!recreatedIdentity) {
        throw new WorkspaceMigrationUnsafePathError(
          `Recreated workspace directory has no stable identity: ${candidate.destination}`,
        );
      }
      await assertFastDirectoryIdentity(
        candidate.destination,
        recreatedIdentity,
        `Recreated fast migration destination for ${entry.id}`,
      );
    } else {
      await assertFastDirectoryIdentity(
        candidate.destination,
        expectedIdentity,
        `Published fast migration destination for ${entry.id}`,
      );
    }
    const ignoredRelativePaths = new Set<string>();
    for (const plan of entry.links) {
      await assertFastLinkBindings(entry, candidate, plan);
      const link = nativePath(candidate.destination, plan.relativePath);
      const target = await readFastLinkTarget(link, 'Published workspace link');
      if (target === undefined || !fastLinkTargetMatches(target, plan.newTarget, plan.linkType)) {
        throw new WorkspaceMigrationConflictError(
          candidate.subtree,
          link,
          candidate.destination,
          'replacement link changed before completion',
        );
      }
      const replacement = fastLinkArtifactPath(candidate, journal.transactionId, plan.relativePath, 'new');
      if (await lstatOptional(replacement)) {
        throw new WorkspaceMigrationConflictError(
          candidate.subtree,
          replacement,
          candidate.destination,
          'unexpected replacement artifact exists before completion',
        );
      }
      const backup = fastLinkArtifactPath(candidate, journal.transactionId, plan.relativePath, 'old');
      const backupTarget = await readFastLinkTarget(backup, 'Fast migration backup link');
      if (backupTarget !== undefined && !fastLinkTargetMatches(backupTarget, plan.oldTarget, plan.linkType)) {
        throw new WorkspaceMigrationConflictError(candidate.subtree, backup, candidate.destination);
      }
      ignoredRelativePaths.add(manifestPathIdentity(
        path.relative(candidate.destination, backup).split(path.sep).join('/'),
      ));
    }

    // This structural pass never opens ordinary payload bytes. Ignoring only
    // the exact, already-verified backup links lets us compare the post-repair
    // tree to the durable preflight digest byte-for-byte at the metadata level.
    const manifest = await buildManifest(
      candidate.destination,
      candidate.sources,
      `final structural verification for ${entry.id}`,
      { hashFileContents: false, ignoredRelativePaths },
    );
    if (
      !manifest
      || manifest.entries[0]?.type !== 'directory'
      || manifest.digest !== entry.structuralDigest
      || manifest.relocatedLinks !== 0
      || manifest.hardLinkedFilePaths.length !== 0
    ) {
      throw new WorkspaceMigrationConflictError(
        candidate.subtree,
        candidate.destination,
        candidate.destination,
        'fast migration output differs from its bound structural inventory',
      );
    }
  }
}

async function cleanupFastTransaction(journal: FastMigrationJournal): Promise<void> {
  journal.phase = 'cleanup';
  await writeFastJournal(journal);
  for (const entry of journal.entries) {
    const candidate = candidateForFastId(entry.id);
    if (!candidate) throw new WorkspaceMigrationMarkerError(`Unknown fast workspace entry: ${entry.id}`);
    for (const plan of entry.links) {
      await assertFastLinkBindings(entry, candidate, plan);
      const link = nativePath(candidate.destination, plan.relativePath);
      const replacement = fastLinkArtifactPath(candidate, journal.transactionId, plan.relativePath, 'new');
      const backup = fastLinkArtifactPath(candidate, journal.transactionId, plan.relativePath, 'old');
      const liveTarget = await readFastLinkTarget(link, 'Published workspace link');
      if (liveTarget === undefined || !fastLinkTargetMatches(liveTarget, plan.newTarget, plan.linkType)) {
        throw new WorkspaceMigrationConflictError(
          candidate.subtree,
          link,
          candidate.destination,
          'published link changed before transaction cleanup',
        );
      }
      const replacementTarget = await readFastLinkTarget(replacement, 'Fast migration replacement link');
      if (replacementTarget !== undefined) {
        throw new WorkspaceMigrationConflictError(
          candidate.subtree,
          replacement,
          candidate.destination,
          'unexpected replacement artifact exists during cleanup',
        );
      }
      const backupTarget = await readFastLinkTarget(backup, 'Fast migration backup link');
      if (backupTarget !== undefined) {
        if (!fastLinkTargetMatches(backupTarget, plan.oldTarget, plan.linkType)) {
          throw new WorkspaceMigrationConflictError(candidate.subtree, backup, candidate.destination);
        }
        // Link backups are removed with unlink only. Never recurse through a
        // junction or a path that changed type after the marker was committed.
        await assertFastLinkBindings(entry, candidate, plan);
        const recheckedBackup = await readFastLinkTarget(backup, 'Fast migration backup link');
        if (
          recheckedBackup === undefined
          || !fastLinkTargetMatches(recheckedBackup, plan.oldTarget, plan.linkType)
        ) {
          throw new WorkspaceMigrationConflictError(candidate.subtree, backup, candidate.destination);
        }
        await fs.unlink(backup);
        await syncDirectory(path.dirname(link));
      }
    }
  }
  journal.phase = 'committed';
  await writeFastJournal(journal);
  await fs.unlink(fastJournalPath());
  await syncDirectory(getWorkspacesDir());
  migrationConsole('cleanup complete', {
    transactionId: journal.transactionId,
    strategy: 'atomic moves',
  });
}

async function applyFastEntries(journal: FastMigrationJournal): Promise<void> {
  for (const [entryIndex, entry] of journal.entries.entries()) {
    const candidate = candidateForFastId(entry.id);
    if (!candidate) throw new WorkspaceMigrationMarkerError(`Unknown fast workspace entry: ${entry.id}`);
    migrationConsole('commit entry started', {
      transactionId: journal.transactionId,
      position: `${entryIndex + 1}/${journal.entries.length}`,
      subtree: entry.subtree,
      outcome: entry.outcome,
      strategy: entry.action === 'move' ? 'atomic directory rename' : 'in-place validation',
    });
    if (entry.action === 'move') await executeFastMove(entry, candidate);
    for (const plan of entry.links) await applyFastLinkPlan(entry, candidate, journal, plan);
    migrationConsole('commit entry published', {
      transactionId: journal.transactionId,
      position: `${entryIndex + 1}/${journal.entries.length}`,
      subtree: entry.subtree,
    });
  }
}

async function ensureFastWorkspaceDirs(
  journal: FastMigrationJournal,
  markerAlreadyExists: boolean,
): Promise<Set<string>> {
  const recreatedAfterMarker = new Set<string>();
  if (markerAlreadyExists) {
    for (const entry of journal.entries) {
      if (
        entry.action !== 'current'
        || entry.outcome !== 'created'
        || !entry.destinationIdentity
      ) continue;
      const candidate = candidateForFastId(entry.id);
      if (!candidate) throw new WorkspaceMigrationMarkerError(`Unknown fast workspace entry: ${entry.id}`);
      if (!(await lstatOptional(candidate.destination))) recreatedAfterMarker.add(entry.id);
    }
  }
  await ensureWorkspaceDirs(DEFAULT_WORKSPACE);
  // Directory entry creation must reach stable storage before a durable layout
  // marker can claim that every workspace subtree exists.
  await syncDirectory(getWorkspaceDir(DEFAULT_WORKSPACE));
  await bindCreatedFastEntries(journal, recreatedAfterMarker);
  return recreatedAfterMarker;
}

async function finishFastTransaction(journal: FastMigrationJournal): Promise<WorkspaceLayoutMarker> {
  validateFastJournal(journal);
  migrationConsole('transaction continuing', {
    transactionId: journal.transactionId,
    phase: journal.phase,
    entries: journal.entries.length,
    strategy: 'atomic moves',
  });
  const existingMarker = await readMarker();
  if (
    existingMarker?.version === WORKSPACE_LAYOUT_VERSION
    && existingMarker.transactionId === journal.transactionId
  ) {
    if (existingMarker.manifestDigest !== fastJournalDigest(journal)) {
      throw new WorkspaceMigrationMarkerError(
        'Fast workspace migration journal no longer matches its durable completion marker.',
      );
    }
    await applyFastEntries(journal);
    const recreatedAfterMarker = await ensureFastWorkspaceDirs(journal, true);
    await validateFastPublishedLayout(journal, recreatedAfterMarker);
    await cleanupFastTransaction(journal);
    await validateCompletedLayout();
    return existingMarker;
  }

  journal.phase = 'applying';
  await writeFastJournal(journal);
  await applyFastEntries(journal);
  await ensureFastWorkspaceDirs(journal, false);
  await validateFastPublishedLayout(journal);
  await fastCheckpoint('before-fast-marker');
  await checkpoint('before-marker');
  journal.phase = 'marker';
  await writeFastJournal(journal);
  const marker: WorkspaceLayoutMarker = {
    version: WORKSPACE_LAYOUT_VERSION,
    completedAt: new Date().toISOString(),
    defaultWorkspace: DEFAULT_WORKSPACE,
    subtrees: aggregateOutcomes(journal.entries),
    transactionId: journal.transactionId,
    manifestDigest: fastJournalDigest(journal),
  };
  await writeJsonAtomic(markerPath(), marker);
  migrationConsole('completion marker published', {
    transactionId: journal.transactionId,
    marker: markerPath(),
    strategy: 'atomic moves',
  });
  await fastCheckpoint('after-fast-marker');
  await checkpoint('after-marker');
  await cleanupFastTransaction(journal);
  return marker;
}

async function finishTransaction(journal: MigrationJournal): Promise<WorkspaceLayoutMarker> {
  migrationConsole('transaction continuing', {
    transactionId: journal.transactionId,
    phase: journal.phase,
    entries: journal.entries.length,
  });
  const existingMarker = await readMarker();
  if (
    existingMarker?.version === WORKSPACE_LAYOUT_VERSION
    && existingMarker.transactionId === journal.transactionId
  ) {
    if (existingMarker.manifestDigest !== journalDigest(journal)) {
      throw new WorkspaceMigrationMarkerError(
        'Workspace migration journal no longer matches its durable completion marker.',
      );
    }
    if (!['cleanup', 'committed'].includes(journal.phase)) {
      migrationConsole('revalidating durable transaction before cleanup', {
        transactionId: journal.transactionId,
        phase: journal.phase,
      });
      journal.phase = 'committing';
      await writeJournal(journal);
      for (const entry of journal.entries) await executeEntry(entry, journal);
      await ensureWorkspaceDirs(DEFAULT_WORKSPACE);
      await syncDirectory(getWorkspaceDir(DEFAULT_WORKSPACE));
      for (const entry of journal.entries) {
        await requireDigest(entry.destination, entry.expectedDigest, entry.subtree);
      }
      journal.phase = 'marker';
      await writeJournal(journal);
    }
    await republishLegacyHardlinkedDestinations(journal);
    await cleanupTransaction(journal);
    return existingMarker;
  }

  journal.phase = 'committing';
  await writeJournal(journal);
  for (const [entryIndex, entry] of journal.entries.entries()) {
    migrationConsole('commit entry started', {
      transactionId: journal.transactionId,
      position: `${entryIndex + 1}/${journal.entries.length}`,
      subtree: entry.subtree,
      outcome: entry.outcome,
    });
    await executeEntry(entry, journal);
    migrationConsole('commit entry published', {
      transactionId: journal.transactionId,
      position: `${entryIndex + 1}/${journal.entries.length}`,
      subtree: entry.subtree,
    });
  }
  await ensureWorkspaceDirs(DEFAULT_WORKSPACE);
  await republishLegacyHardlinkedDestinations(journal);
  await checkpoint('before-marker');
  journal.phase = 'marker';
  await writeJournal(journal);
  const marker: WorkspaceLayoutMarker = {
    version: WORKSPACE_LAYOUT_VERSION,
    completedAt: new Date().toISOString(),
    defaultWorkspace: DEFAULT_WORKSPACE,
    subtrees: aggregateOutcomes(journal.entries),
    transactionId: journal.transactionId,
    manifestDigest: journalDigest(journal),
  };
  await writeJsonAtomic(markerPath(), marker);
  migrationConsole('completion marker published', {
    transactionId: journal.transactionId,
    marker: markerPath(),
  });
  await checkpoint('after-marker');
  await cleanupTransaction(journal);
  log.info('Workspace layout v2 ready', {
    workspaceRoot: getWorkspaceDir(DEFAULT_WORKSPACE),
    transactionId: journal.transactionId,
    subtrees: marker.subtrees,
  });
  return marker;
}

async function hasLegacyRoots(): Promise<boolean> {
  const candidates = await discoverCandidates();
  for (const candidate of candidates) {
    for (const source of candidate.sources) {
      await assertManagedPathAncestors(source);
      const stat = await lstatOptional(source);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        throw new WorkspaceMigrationUnsafePathError(`Managed root must not be a symlink or junction: ${source}`);
      }
      // Any non-directory root or any child (including an empty nested
      // directory) needs a real preflight pass. Presence detection must not
      // re-hash an entire userdata repository after every commit/restart.
      if (!stat.isDirectory() || (await fs.readdir(source)).length > 0) return true;
    }
  }
  return false;
}

async function validateCompletedLayout(): Promise<void> {
  await assertRealDirectory(getWorkspaceDir(DEFAULT_WORKSPACE), 'Default workspace root');
  for (const subtree of WORKSPACE_SUBTREES) {
    await assertRealDirectory(
      path.join(getWorkspaceDir(DEFAULT_WORKSPACE), subtree),
      `Default workspace ${subtree} subtree`,
    );
  }
}

async function runMigration(): Promise<WorkspaceLayoutMarker> {
  await prepareRoots();
  const lock = await acquireMigrationLock();
  migrationConsole('exclusive lock acquired', {
    pid: process.pid,
    lock: lockPath(),
  });
  try {
    await prepareRoots();
    let [existing, durableJournal, durableFastJournal] = await Promise.all([
      readMarker(),
      readJournal(),
      readFastJournal(),
    ]);
    if (durableJournal && durableFastJournal) {
      throw new WorkspaceMigrationMarkerError(
        'Both full and fast workspace migration journals exist; refusing to guess which transaction owns the data.',
      );
    }
    if (durableJournal) {
      migrationConsole('recovering durable transaction', {
        transactionId: durableJournal.transactionId,
        phase: durableJournal.phase,
        journalSchema: durableJournal.schemaVersion,
        strategy: 'content-verified copy/merge recovery',
        note: durableJournal.schemaVersion === LEGACY_JOURNAL_SCHEMA_VERSION
          ? 'an interrupted legacy transaction must finish safely before atomic moves can be used'
          : undefined,
      });
    } else if (durableFastJournal) {
      migrationConsole('recovering durable transaction', {
        transactionId: durableFastJournal.transactionId,
        phase: durableFastJournal.phase,
        strategy: 'atomic moves',
      });
    } else if (existing) {
      migrationConsole('existing layout marker found', {
        version: existing.version,
        transactionId: existing.transactionId,
      });
    }
    for (let pass = 1; pass <= MAX_RECONCILIATION_PASSES; pass++) {
      migrationConsole('reconciliation pass', {
        pass,
        maximum: MAX_RECONCILIATION_PASSES,
      });
      if (durableJournal) {
        existing = await finishTransaction(durableJournal);
        durableJournal = undefined;
      } else if (durableFastJournal) {
        existing = await finishFastTransaction(durableFastJournal);
        durableFastJournal = undefined;
      } else if (existing?.version === WORKSPACE_LAYOUT_VERSION && !(await hasLegacyRoots())) {
        await validateCompletedLayout();
        migrationConsole('layout already current; no data move required', {
          workspaceRoot: getWorkspaceDir(DEFAULT_WORKSPACE),
        });
        return existing;
      } else {
        const transactionId = randomUUID();
        const fastJournal = await planFastMigration(transactionId);
        if (fastJournal) {
          await writeFastJournal(fastJournal);
          await fastCheckpoint('after-fast-preflight');
          existing = await finishFastTransaction(fastJournal);
        } else {
          migrationConsole('strategy selected', {
            strategy: 'content-verified copy/merge',
            reason: 'atomic no-copy migration is not safe for this on-disk layout',
          });
          const journal = await preflight(transactionId);
          await fs.mkdir(path.join(transactionsPath(), journal.transactionId, 'stage'), { recursive: true });
          await writeJournal(journal);
          await checkpoint('after-preflight');
          existing = await finishTransaction(journal);
        }
      }

      // A pre-workspace process can recreate a legacy root after we atomically
      // archived it. Do not memoize readiness with that late data invisible:
      // reconcile it in a fresh transaction while this process still owns the
      // installation lock.
      if (!(await hasLegacyRoots())) {
        await validateCompletedLayout();
        return existing;
      }
      log.warn('Legacy workspace data reappeared during migration; reconciling another pass', { pass });
    }
    throw new WorkspaceMigrationConflictError(
      'workspace layout',
      getDataDir(),
      getWorkspaceDir(DEFAULT_WORKSPACE),
      `legacy data kept reappearing across ${MAX_RECONCILIATION_PASSES} reconciliation passes`,
    );
  } finally {
    await lock.release().catch(error => log.error('Failed to release workspace migration lock', error));
    migrationConsole('exclusive lock released', { lock: lockPath() });
  }
}
