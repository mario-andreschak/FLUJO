import { openOAuthPopup, reserveOAuthPopup } from '@/frontend/utils/oauth';

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

it('reports blocked popups before starting asynchronous authentication', () => {
  jest.spyOn(window, 'open').mockReturnValue(null);
  expect(() => reserveOAuthPopup('oauth_test')).toThrow('Allow popups for FLUJO');
});

it('uses the window reserved by the click and returns the provider error without replacing it', async () => {
  const popup = {
    closed: false, location: { href: 'about:blank' }, focus: jest.fn(),
    close: jest.fn(function(this: { closed: boolean }) { this.closed = true; }),
  };
  const open = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const reserved = reserveOAuthPopup('oauth_test');
  const onError = jest.fn();
  const result = openOAuthPopup({ url: 'https://oauth.example/authorize', popup: reserved, onError });
  expect(open).toHaveBeenCalledTimes(1);
  expect(popup.location.href).toBe('https://oauth.example/authorize');
  popup.location.href = 'http://localhost/mcp?oauth_error=invalid_request&error_description=redirect_uri+did+not+match';
  const rejection = expect(result).rejects.toThrow('redirect_uri did not match');
  jest.advanceTimersByTime(1000);
  await rejection;
  expect(onError).toHaveBeenCalledWith('OAuth error: invalid_request - redirect_uri did not match');
  expect(popup.closed).toBe(true);
});
