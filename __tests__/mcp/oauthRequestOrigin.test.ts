import { requestOrigin } from '@/utils/http/requestOrigin';

it('uses the browser host instead of the Docker bind address for OAuth redirects', () => {
  const request = new Request('http://0.0.0.0:4200/api/oauth/initiate', {
    headers: { host: '127.0.0.1:43420' },
  });
  expect(new URL('/api/oauth/callback?workspace=default-workspace', requestOrigin(request)).href)
    .toBe('http://127.0.0.1:43420/api/oauth/callback?workspace=default-workspace');
});

it('uses the same public origin on callback and completion behind a TLS proxy', () => {
  const headers = { host: 'worker:4200', 'x-forwarded-host': 'flujo.example', 'x-forwarded-proto': 'https' };
  for (const path of ['/api/oauth/initiate', '/api/oauth/callback']) {
    const origin = requestOrigin(new Request(`http://0.0.0.0:4200${path}`, { headers }));
    expect(origin).toBe('https://flujo.example');
    expect(new URL('/mcp', origin).href).toBe('https://flujo.example/mcp');
  }
});

it('retains the direct request origin without proxy headers', () => {
  expect(requestOrigin(new Request('http://localhost:4200/api/oauth/initiate')))
    .toBe('http://localhost:4200');
});
