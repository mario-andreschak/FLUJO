#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_DIAGNOSTIC_CHARS = 12_000;
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function sanitizeInstallOutput(input, env = process.env) {
  let safe = String(input ?? '');
  safe = safe.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');
  safe = safe.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, '$1[REDACTED]');
  safe = safe.replace(/(\/\/[^\s:=]+(?::\d+)?\/:_authToken=)[^\s]+/gi, '$1[REDACTED]');
  safe = safe.replace(/([?&](?:access_token|auth|key|password|secret|token)=)[^&\s]+/gi, '$1[REDACTED]');
  safe = safe.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY))=([^\s]+)/gi, '$1=[REDACTED]');

  for (const [name, value] of Object.entries(env)) {
    if (!value || String(value).length < 4) continue;
    if (
      /(?:proxy|token|secret|password|key|auth|ca(?:file|certs)?)/i.test(name) ||
      name === 'NODE_EXTRA_CA_CERTS'
    ) {
      safe = safe.split(String(value)).join('[REDACTED]');
    }
  }

  return safe.length > MAX_DIAGNOSTIC_CHARS ? safe.slice(-MAX_DIAGNOSTIC_CHARS) : safe;
}

export function classifyBrowserInstallFailure(output) {
  const text = String(output ?? '').toLowerCase();
  if (/self.signed|unable to verify|certificate|cert_has_expired|unknown issuer|tls|ssl/.test(text)) {
    return {
      category: 'TLS_TRUST',
      remediation: 'Trust the approved corporate CA or set FLUJO_EXTRA_CA_CERTS to a readable PEM certificate file.',
    };
  }
  if (/\b407\b|proxy authentication|required proxy|proxy auth/.test(text)) {
    return {
      category: 'PROXY_AUTH',
      remediation: 'Check HTTPS_PROXY/HTTP_PROXY credentials and NO_PROXY, then retry the Chromium stage.',
    };
  }
  if (/enotfound|eai_again|name or service not known|dns/.test(text)) {
    return {
      category: 'DNS',
      remediation: 'Check DNS and the browser download host allowlist, then retry the Chromium stage.',
    };
  }
  if (/etimedout|esockettimedout|timeout|timed out/.test(text)) {
    return {
      category: 'TIMEOUT',
      remediation: 'Check proxy reachability or increase FLUJO_PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT.',
    };
  }
  if (/host system is missing dependencies|missing librar|install-deps/.test(text)) {
    return {
      category: 'OS_DEPENDENCY',
      remediation: 'Install the operating-system browser dependencies reported above, then retry.',
    };
  }
  if (/eacces|eperm|permission denied|enospc|no space left/.test(text)) {
    return {
      category: 'FILESYSTEM',
      remediation: 'Check browser-cache permissions and free disk space, then retry.',
    };
  }
  return {
    category: 'BROWSER_DOWNLOAD',
    remediation: 'Check the sanitized diagnostic above and retry only this stage after correcting the cause.',
  };
}

function writeResultFile(result, env) {
  const resultPath = env.FLUJO_INSTALL_RESULT_FILE;
  if (!resultPath) return;
  try {
    writeFileSync(resultPath, JSON.stringify(result, null, 2), { encoding: 'utf8' });
  } catch (error) {
    process.stderr.write(
      '[FLUJO installer] Could not write the browser-stage result file: ' +
        sanitizeInstallOutput(error?.message, env) +
        '\n',
    );
  }
}

export function runBrowserInstall({
  env = process.env,
  spawn = spawnSync,
  stderr = process.stderr,
} = {}) {
  if (TRUTHY.has(String(env.FLUJO_SKIP_PATCHRIGHT_DOWNLOAD ?? '').toLowerCase())) {
    stderr.write('[FLUJO installer] Managed Chromium download deferred to the explicit patchright-chromium stage.\n');
    const result = { ok: true, stage: 'patchright-chromium', skipped: true, exitCode: 0 };
    writeResultFile(result, env);
    return result;
  }

  let child;
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve('patchright/package.json');
    const cli = join(dirname(packageJson), 'cli.js');
    const childEnv = { ...env };
    delete childEnv.NODE_TLS_REJECT_UNAUTHORIZED;
    child = spawn(process.execPath, [cli, 'install', 'chromium', '--no-progress'], {
      cwd: resolve(dirname(packageJson)),
      env: childEnv,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: false,
    });
  } catch (error) {
    child = { status: 1, stdout: '', stderr: '', error };
  }

  const combined = sanitizeInstallOutput(
    [child.stdout, child.stderr, child.error?.message].filter(Boolean).join('\n'),
    env,
  );
  if (combined) stderr.write(combined.trimEnd() + '\n');

  const exitCode = Number.isInteger(child.status) ? child.status : 1;
  if (exitCode === 0) {
    const result = { ok: true, stage: 'patchright-chromium', skipped: false, exitCode };
    writeResultFile(result, env);
    return result;
  }

  const failure = classifyBrowserInstallFailure(combined);
  const result = {
    ok: false,
    stage: 'patchright-chromium',
    code: 'BROWSER_UNAVAILABLE',
    retryable: true,
    category: failure.category,
    remediation: failure.remediation,
    exitCode,
  };
  stderr.write(
    '[FLUJO installer] Install managed Chromium failed (' +
      failure.category +
      ', exit ' +
      exitCode +
      '). ' +
      failure.remediation +
      '\n',
  );
  stderr.write(
    '[FLUJO installer] Retry from the FLUJO directory with: npm run install --workspace=@mario.andreschak/mcp-browser\n',
  );
  writeResultFile(result, env);
  return result;
}

function main() {
  const result = runBrowserInstall();
  process.exitCode = result.exitCode;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
