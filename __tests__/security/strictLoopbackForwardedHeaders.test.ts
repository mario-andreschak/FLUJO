import { assertLocalRequest } from '@/utils/http/localRequest';

const previousExposureMode = process.env.FLUJO_EXPOSURE_MODE;

function nextDeliveredRequest(
  overrides: Record<string, string | undefined> = {},
): Request {
  const headers: Record<string, string> = {
    host: '127.0.0.1:4200',
    'x-forwarded-host': '127.0.0.1:4200',
    'x-forwarded-for': '127.0.0.1',
    'x-forwarded-proto': 'http',
    'x-forwarded-port': '4200',
  };

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }

  return new Request('http://127.0.0.1:4200/v1/personas', { headers });
}

function expectDenied(request: Request): void {
  const response = assertLocalRequest(request, { strictLoopback: true });
  expect(response).not.toBeNull();
  expect(response?.status).toBe(403);
}

describe('strict loopback forwarding headers', () => {
  beforeEach(() => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  });

  afterAll(() => {
    if (previousExposureMode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
    else process.env.FLUJO_EXPOSURE_MODE = previousExposureMode;
  });

  it('allows the headers Next.js injects for a direct IPv4 loopback request', () => {
    expect(assertLocalRequest(nextDeliveredRequest(), { strictLoopback: true })).toBeNull();
  });

  it('allows the headers Next.js injects for a same-origin localhost browser request', () => {
    expect(assertLocalRequest(nextDeliveredRequest({
      host: 'localhost:4200',
      origin: 'http://localhost:4200',
      'x-forwarded-host': 'localhost:4200',
    }), { strictLoopback: true })).toBeNull();
  });

  it.each([
    ['a remote forwarded client', { 'x-forwarded-for': '203.0.113.9' }],
    ['a multi-hop forwarded chain', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }],
    ['a rewritten forwarded host', { 'x-forwarded-host': 'evil.example.com' }],
    ['x-real-ip', { 'x-real-ip': '203.0.113.9' }],
    ['the standardized Forwarded header', { forwarded: 'for=203.0.113.9' }],
    ['a TLS-terminating forwarded protocol', { 'x-forwarded-proto': 'https' }],
  ])('denies %s', (_label, headers) => {
    expectDenied(nextDeliveredRequest(headers));
  });

  it.each(['network', 'public'])(
    'denies an otherwise clean loopback request in %s exposure mode',
    (mode) => {
      process.env.FLUJO_EXPOSURE_MODE = mode;
      expectDenied(nextDeliveredRequest());
    },
  );

  it.each(['::1', '::ffff:127.0.0.1'])(
    'allows Windows/IPv6 loopback peer address %s',
    (address) => {
      expect(assertLocalRequest(nextDeliveredRequest({
        'x-forwarded-for': address,
      }), { strictLoopback: true })).toBeNull();
    },
  );
});
