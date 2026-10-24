const bundled = jest.fn();
const version = jest.fn();
jest.mock('@/backend/services/model/adapters/codexRestrictedProfile', () => ({ bundledCodexExecutable: () => bundled() }));
jest.mock('@/backend/services/model/adapters/codexRuntimeUpdate', () => ({ readOrdinaryCodexVersion: (path: string) => version(path) }));
import { codexLoginCommand, inspectBundledCodexSetup } from '@/backend/services/model/adapters/codexSetup';

it('uses the executable already shipped with FLUJO', async () => {
  bundled.mockReturnValue('C:\\Program Files\\FLUJO\\codex.exe');
  version.mockResolvedValue('0.162.1');
  expect(await inspectBundledCodexSetup()).toEqual({ bundled: true,
    loginCommand: codexLoginCommand('C:\\Program Files\\FLUJO\\codex.exe') });
  expect(version).toHaveBeenCalledWith('C:\\Program Files\\FLUJO\\codex.exe');
});
it('offers installation only when the bundled executable cannot run', async () => {
  version.mockRejectedValue(new Error('missing executable'));
  expect(await inspectBundledCodexSetup()).toEqual({ bundled: false });
});
it('quotes literal Windows and POSIX paths', () => {
  expect(codexLoginCommand("C:\\Mo'e $home\\codex.exe", 'win32')).toBe("& 'C:\\Mo''e $home\\codex.exe' login");
  expect(codexLoginCommand("/a'b/codex", 'linux')).toBe("'/a'\\''b/codex' login");
});
