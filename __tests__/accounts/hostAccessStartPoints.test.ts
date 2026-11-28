import fs from 'node:fs';
import path from 'node:path';

/**
 * In multi-user mode, starting a program on the server needs host access
 * (#574, step 574-4). Routes are covered by `routeCapabilities.test.ts`; this
 * test covers the services that start programs, because ordinary workspace
 * routes and background work lead there too.
 *
 * Every file under src/backend and src/utils that can start a program must
 * either call `assertHostAccess` (or attach `attachHostAccessCheck`) before
 * the program starts, or be listed below with the reason it needs no check.
 */

const ROOT = process.cwd();

/** Files that start programs a person chooses or that can read other people's files. */
const CHECKED: Readonly<Record<string, RegExp>> = {
  'src/backend/services/mcp/connection.ts': /if \(!isolation\) attachHostAccessCheck\(transport\)/,
  'src/backend/services/mcp/githubInstall.ts': /await assertHostAccess\('github-install'\)/,
  'src/backend/services/mcp/systemScreenshot.ts': /await assertHostAccess\('system-screenshot'\)/,
  'src/backend/services/model/adapters/antigravityCliProcess.ts': /await assertHostAccess\('command-line-model'\)[\s\S]*await assertHostAccess\('command-line-model'\)/,
  'src/backend/services/model/adapters/codexAppServerProcess.ts': /await assertHostAccess\('command-line-model'\)/,
  'src/backend/services/originalOwner/nativeToolEffects.ts': /await assertHostAccess\('owner-native-tool'\)/,
};

/** Files that start programs but need no person-level check, and why. */
const REVIEWED: Readonly<Record<string, string>> = {
  'src/backend/services/model/adapters/claudeOwnedProcess.ts': 'spawner hook; claudeSubscriptionAdapter.ts checks host access before every Claude Code turn',
  'src/backend/services/model/adapters/codexRestrictedProfile.ts': 'fixed `codex --version` probe; the real start is checked in startOwnedCodexAppServer',
  'src/backend/services/model/adapters/codexRuntimeUpdate.ts': 'FLUJO updates its own bundled Codex from the official npm package; the Codex start itself is checked',
  'src/backend/services/enduringAgents/runtimeLock.ts': 'reads process identities of FLUJO\'s own children',
  'src/backend/services/security/isolatedMcp.ts': 'starts MCP servers inside the isolated container, which needs no host access',
  'src/backend/services/mcp/securityReview/runner.ts': 'runs the security review inside a container',
  'src/backend/services/security/windowsPrivateAuthority.ts': 'sets private file permissions on FLUJO\'s own files',
  'src/backend/services/ollama/capability.ts': 'fixed `nvidia-smi` probe for model suggestions',
  'src/backend/services/snapshot/openSnapshotFolder.ts': 'only reachable from /api/snapshots/open-folder, a host route',
  'src/utils/process/killProcessTree.ts': 'stops FLUJO\'s own child processes',
  'src/utils/encryption/systemKeyStore.ts': 'keeps FLUJO\'s own encryption key in the system key store with the system\'s fixed tools '
    + '(PowerShell data protection, macOS `security`, `secret-tool`); nobody chooses what runs, and every person needs that key to open FLUJO',
  'src/utils/mcp/directExecution.ts': 'not called anywhere; a caller must add assertHostAccess',
};

function collect(directory: string): string[] {
  return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return collect(relative);
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [relative] : [];
  });
}

describe('programs started on the server check host access', () => {
  const starters = [...collect('src/backend'), ...collect('src/utils')]
    .filter(file => /from ['"](?:node:)?child_process['"]/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));

  it('lists every file that can start a program', () => {
    const unlisted = starters.filter(file => !(file in CHECKED) && !(file in REVIEWED));
    if (unlisted.length) {
      throw new Error('These files can start programs on the server. Call `await assertHostAccess(<activity>)` from '
        + '`@/backend/services/accounts/hostAccess` right before the program starts and add the file to CHECKED in '
        + `__tests__/accounts/hostAccessStartPoints.test.ts (or, when no person can choose what runs, to REVIEWED with the reason):\n${unlisted.join('\n')}`);
    }
  });

  it('keeps the check in every listed starter', () => {
    for (const [file, pattern] of Object.entries(CHECKED)) {
      expect([file, pattern.test(fs.readFileSync(path.join(ROOT, file), 'utf8'))]).toEqual([file, true]);
    }
    const claude = fs.readFileSync(path.join(ROOT, 'src/backend/services/model/adapters/claudeSubscriptionAdapter.ts'), 'utf8');
    expect(claude).toMatch(/await assertHostAccess\('command-line-model'\);\s*try \{\s*if \(nativeOriginalProcessHost\)/);
    const beta = fs.readFileSync(path.join(ROOT, 'src/backend/services/mcp/betaClient.ts'), 'utf8');
    expect(beta).toMatch(/if \(!isolation\) attachHostAccessCheck\(transport\)/);
  });

  it('starts only the system\'s own key tools, at fixed paths and without a shell, from the key store', () => {
    const keyStore = fs.readFileSync(path.join(ROOT, 'src/utils/encryption/systemKeyStore.ts'), 'utf8');
    expect(keyStore.match(/\bexecFile\(/g)).toHaveLength(1);
    expect(keyStore).not.toMatch(/\b(?:exec|spawn|execSync|spawnSync|execFileSync|fork)\(|shell:\s*true/);
    expect(keyStore).toMatch(/'WindowsPowerShell', 'v1\.0', 'powershell\.exe'\)/);
    expect(keyStore).toMatch(/const security = '\/usr\/bin\/security';/);
    expect(keyStore).toMatch(/for \(const candidate of \['\/usr\/bin\/secret-tool', '\/usr\/local\/bin\/secret-tool'\]\)/);
    // The Linux store is only ever created for one of those two fixed paths.
    expect(keyStore.match(/secretServiceStore\([^)]*\)/g)).toEqual(['secretServiceStore(secretTool: string)', 'secretServiceStore(candidate)']);
  });

  it('lists no file that is gone or no longer starts programs', () => {
    expect(Object.keys({ ...CHECKED, ...REVIEWED }).filter(file => !starters.includes(file))).toEqual([]);
  });
});
