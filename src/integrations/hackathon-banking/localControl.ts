import { execFile } from 'node:child_process';
import type { BankingPolicy } from './policy';
import { BankingError } from './errors';

/** Fixed private control command. The signed authority is carried only on stdin. */
export function propagateBankingRevocation(policy: BankingPolicy, assertion: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(policy.bankCommand,
      ['-m', 'banking_mcp', 'revoke-session', '--config', policy.bankConfigFile],
      { cwd: policy.bankCwd, timeout: 10000, maxBuffer: 4096, windowsHide: true,
        env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV, PYTHONDONTWRITEBYTECODE: '1' } },
      error => error ? reject(new BankingError('bank_revocation_pending', 503)) : resolve());
    child.stdin?.on('error', () => { /* exit callback reports failure without leaking input */ });
    child.stdin?.end(assertion);
  });
}
