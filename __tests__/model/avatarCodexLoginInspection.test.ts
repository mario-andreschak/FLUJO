jest.mock('@/backend/services/model/adapters/codexAuth', () => ({ readCodexAuthForTransfer: jest.fn() }));
import { readCodexAuthForTransfer } from '@/backend/services/model/adapters/codexAuth';
import { inspectCodexLogin } from '@/backend/services/avatar/codexLoginInspection';
const read = readCodexAuthForTransfer as jest.Mock;
beforeEach(() => read.mockReset());

test('existing authoritative login read is projected without exposing or copying credentials', async () => {
  read.mockResolvedValue(Buffer.from('private-fixture'));
  expect(await inspectCodexLogin('existing-workspace')).toEqual({ authentication: 'login-detected' });
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('existing-workspace');
});

test.each([
  ['A file-backed Codex ChatGPT login is required. Sign in with Codex using file credential storage before cloning.', 'needs-connection', 'login-missing'],
  ['The Codex authentication cache is not a transferable ChatGPT login.', 'incompatible', 'login-incompatible'],
  ['unexpected private diagnostic fixture', 'unknown', 'inspection-unavailable'],
])('only fixed classification escapes a failed login read', async (message, authentication, reasonCode) => {
  read.mockRejectedValue(new Error(message));
  expect(await inspectCodexLogin()).toEqual({ authentication, reasonCode });
});
