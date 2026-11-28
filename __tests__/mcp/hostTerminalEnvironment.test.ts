import { hostTerminalEnvironment } from '@/backend/services/mcp/hostTerminalEnvironment';

describe('the bundled Bash server environment', () => {
  test('the host wins for every key it defines, whatever the letter case on the server record', () => {
    const result = hostTerminalEnvironment(
      { Path: '/saved/bin', HOME: '/saved/home', API_REGION: 'eu' },
      { PATH: '/host/bin', HOME: '/host/home', API_REGION: 'us' },
    );
    expect(result).toEqual({ PATH: '/host/bin', HOME: '/host/home', API_REGION: 'us' });
  });

  test('a saved home or config location the host does not define is removed, so no CLI is pointed elsewhere', () => {
    const result = hostTerminalEnvironment(
      {
        HOME: '/saved/private-home', USERPROFILE: 'C:\\saved\\profile', Gh_Config_Dir: '/saved/gh',
        XDG_CONFIG_HOME: '/saved/config', APPDATA: 'C:\\saved\\appdata', TMPDIR: '/saved/tmp',
      },
      { PATH: '/host/bin' },
    );
    expect(result).toEqual({ PATH: '/host/bin' });
  });

  test('saved values for anything else the host does not define stay available', () => {
    const result = hostTerminalEnvironment({ GITHUB_TOKEN: 'saved-token', EDITOR: 'vim' }, { PATH: '/host/bin', HOME: '/host/home' });
    expect(result).toEqual({ GITHUB_TOKEN: 'saved-token', EDITOR: 'vim', PATH: '/host/bin', HOME: '/host/home' });
  });

  test('the server record is never changed', () => {
    const saved = { HOME: '/saved/home' };
    hostTerminalEnvironment(saved, {});
    expect(saved).toEqual({ HOME: '/saved/home' });
  });
});
