import { execFile } from 'node:child_process';
import { propagateBankingRevocation } from '@/backend/services/banking/localControl';
import type { BankingPolicy } from '@/backend/services/banking/policy';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

test('private revocation passes authority only on stdin to the pinned local command', async () => {
  const end = jest.fn();
  jest.mocked(execFile).mockImplementation((...args: unknown[]) => {
    queueMicrotask(() => (args[3] as (error: Error | null) => void)(null));
    return { stdin: { on: jest.fn(), end } } as never;
  });
  const policy = { bankCommand: '/opt/bank/python', bankCwd: '/opt/bank', bankConfigFile: '/run/bank.json' } as BankingPolicy;
  await propagateBankingRevocation(policy, 'SECRET_ASSERTION');
  expect(execFile).toHaveBeenCalledWith(policy.bankCommand,
    ['-m', 'banking_mcp', 'revoke-session', '--config', policy.bankConfigFile],
    expect.objectContaining({ cwd: policy.bankCwd, timeout: 10000, windowsHide: true }), expect.any(Function));
  expect(JSON.stringify(jest.mocked(execFile).mock.calls)).not.toContain('SECRET_ASSERTION');
  expect(end).toHaveBeenCalledWith('SECRET_ASSERTION');
});
