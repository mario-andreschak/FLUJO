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

it.each(['success', 'error', 'invalid', 'closed'])(
  'releases polling and the deadline after %s settlement', async (outcome) => {
    const popup = {
      closed: false, location: { href: 'about:blank' }, focus: jest.fn(),
      close: jest.fn(function(this: { closed: boolean }) { this.closed = true; }),
    };
    const onSuccess = jest.fn();
    const onError = jest.fn();
    const onClose = jest.fn();
    const result = openOAuthPopup({
      url: 'https://oauth.example/authorize', popup: popup as unknown as Window,
      onSuccess, onError, onClose,
    });
    const settled = outcome === 'success'
      ? expect(result).resolves.toEqual({ serverName: 'test' })
      : expect(result).rejects.toThrow();
    popup.location.href = outcome === 'success'
      ? 'http://localhost/mcp?oauth_success=test'
      : outcome === 'error'
        ? 'http://localhost/mcp?oauth_error=access_denied'
        : 'http://localhost/mcp';
    if (outcome === 'closed') popup.closed = true;
    jest.advanceTimersByTime(1000);
    await settled;
    const callbacks = [onSuccess.mock.calls.length, onError.mock.calls.length, onClose.mock.calls.length];
    expect(jest.getTimerCount()).toBe(0);
    // A reused reserved window must not be closed by the previous flow's deadline.
    popup.closed = false;
    popup.location.href = 'https://oauth.example/another-flow';
    const closes = popup.close.mock.calls.length;
    jest.advanceTimersByTime(300000);
    expect(popup.close).toHaveBeenCalledTimes(closes);
    expect([onSuccess.mock.calls.length, onError.mock.calls.length, onClose.mock.calls.length]).toEqual(callbacks);
  },
);

it('stops monitoring when a cross-origin popup reaches the deadline', async () => {
  const popup = {
    closed: false, location: { href: 'about:blank' }, focus: jest.fn(),
    close: jest.fn(function(this: { closed: boolean }) { this.closed = true; }),
  };
  const onError = jest.fn();
  const result = openOAuthPopup({ url: 'https://oauth.example/authorize', popup: popup as unknown as Window, onError });
  Object.defineProperty(popup.location, 'href', { get: () => { throw new Error('Cross-origin access'); } });
  const rejection = expect(result).rejects.toThrow('OAuth authentication timed out');
  jest.advanceTimersByTime(300000);
  await rejection;
  expect(onError).toHaveBeenCalledTimes(1);
  expect(popup.close).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it('settles a closure first observed by the deadline before the poll runs', async () => {
  const timeout = jest.spyOn(globalThis, 'setTimeout');
  const popup = { closed: false, location: { href: 'about:blank' }, focus: jest.fn(), close: jest.fn() };
  const onClose = jest.fn();
  const onError = jest.fn();
  const result = openOAuthPopup({ url: 'https://oauth.example/authorize', popup: popup as unknown as Window, onClose, onError });
  const deadline = timeout.mock.calls.find(([, delay]) => delay === 300000)?.[0];
  expect(deadline).toEqual(expect.any(Function));
  popup.closed = true;
  const rejection = expect(result).rejects.toThrow('OAuth popup was closed by user');
  (deadline as () => void)();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  await rejection;
  (deadline as () => void)();
  expect(onClose).toHaveBeenCalledTimes(1);
});
