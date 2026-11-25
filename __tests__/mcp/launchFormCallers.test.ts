import fs from 'node:fs';
import path from 'node:path';

/**
 * Launch fingerprints and owner-approval digests compare a server config in
 * launch form only: secrets decrypted, globals filled in (#1337). Comparing
 * the saved, encrypted text with what was launched refused every server with
 * a secret env. `secretEnvLaunchApproval.test.ts` proves the behaviour; this
 * test makes every file that computes or compares one say where its config
 * comes from, so a new caller is reviewed before it can compare the wrong form.
 */

const ROOT = process.cwd();
const COMPUTES = /\b(?:localLaunchFingerprint|trustedHostMcpPolicyDigest|trustedHostMcpPolicyDigestAsync|trustedHostMcpPreviewDigestAsync|trustedHostMcpApproval|trustedHostMcpApprovalAsync|verifyTrustedHostMcp|sameTrustedHostConsent)\s*\(/;

/** Each caller, why its configs are in launch form, and the lines that make it so. */
const CALLERS: Readonly<Record<string, { why: string; keeps: readonly RegExp[] }>> = {
  'src/backend/services/mcp/connection.ts': {
    why: 'defines localLaunchFingerprint; the transport factories receive the launch form from connectServer and testConnection',
    keeps: [/export function localLaunchFingerprint\(/],
  },
  'src/backend/services/mcp/localHost.ts': {
    why: 'assertCurrent puts the config it is given into launch form before comparing',
    keeps: [/launchForm\(given\)/],
  },
  'src/backend/services/mcp/trustedHost.ts': {
    why: 'currentConfig() returns and assertCurrent() compares the launch form; the factory input already is one',
    keeps: [/return stdioLaunchForm\(config\);/, /const current = await stdioLaunchForm\(given\);/],
  },
  'src/backend/services/mcp/isolation.ts': {
    why: 'assertHostMcpLaunchAllowed checks the factory input; dispatch leaves the comparison to assertCurrent',
    keeps: [/await localLaunch\.assertCurrent\(stored\)/, /await host\.assertCurrent\(current\)/],
  },
  'src/backend/services/security/trustedHostMcp.ts': {
    why: 'defines the approval digests; every caller passes the launch form',
    keeps: [],
  },
  'src/backend/services/security/bundledMcpConsent.ts': {
    why: 'the digest the owner reviews is computed over the launch form; proposals are compared stored form to stored form',
    keeps: [/trustedHostMcpPreviewDigestAsync\(await stdioLaunchForm\(config\)\)/],
  },
  'src/backend/services/security/packageRunnerConsent.ts': {
    why: 'the digest the owner reviews is computed over the launch form',
    keeps: [/trustedHostMcpPreviewDigestAsync\(await stdioLaunchForm\(config\)\)/],
  },
  'src/backend/services/security/bundledFlujoWorkload.ts': {
    why: 'configs read from disk pass through stdioLaunchForm(); pending configs come from the launched transport',
    keeps: [/const config = await stdioLaunchForm\(first\.config\)/, /sameTrustedHostConsent\(await stdioLaunchForm\(latest\.config\), config\)/,
      /const finalConfig = await stdioLaunchForm\(finalEvidence\.config\)/],
  },
  'src/backend/services/packages/workspaceMcpTransfer.ts': {
    why: 'the approval is verified over the launch form; the copy check compares stored form to stored form',
    keeps: [/verifyTrustedHostMcp\(await stdioLaunchForm\(captured\)\)/],
  },
};

function collect(directory: string): string[] {
  return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return collect(relative);
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [relative] : [];
  });
}

describe('approval digests and launch fingerprints compare the launch form', () => {
  const callers = collect('src').filter(file => COMPUTES.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));

  it('lists every file that computes or compares one', () => {
    const unlisted = callers.filter(file => !(file in CALLERS));
    if (unlisted.length) {
      throw new Error('These files compute or compare an MCP launch fingerprint or approval digest. Pass every saved config '
        + 'through `launchForm()` or `stdioLaunchForm()` from `src/backend/services/mcp/launchForm.ts` first (a config the '
        + 'transport factory received already is one), then add the file to CALLERS in '
        + `__tests__/mcp/launchFormCallers.test.ts with the reason:\n${unlisted.join('\n')}`);
    }
  });

  it('keeps the launch form conversion in every listed caller', () => {
    for (const [file, { keeps }] of Object.entries(CALLERS)) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const pattern of keeps) expect([file, pattern.source, pattern.test(source)]).toEqual([file, pattern.source, true]);
    }
  });

  it('lists no file that is gone or no longer computes one', () => {
    expect(Object.keys(CALLERS).filter(file => !callers.includes(file))).toEqual([]);
  });
});
