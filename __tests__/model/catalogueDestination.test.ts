import { sameCatalogueEndpoint } from '@/backend/services/model/catalogueDestination';

test.each([
  ['https://api.example.com/v1', 'https://API.EXAMPLE.COM:443/v1/', true],
  ['http://127.0.0.1:8787/v1', 'http://127.0.0.1:8787/v1/', true],
  ['https://api.example.com/v1', 'https://api.example.com/v2', false],
  ['https://api.example.com/v1', 'https://api.example.com/v1//', false],
  ['https://api.example.com/v1', 'https://api.example.com:8443/v1', false],
  ['https://api.example.com/v1', 'https://api.example.com.attacker.example/v1', false],
  ['https://api.example.com/v1?a=1', 'https://api.example.com/v1?a=2', false],
  ['https://api.example.com/v1', 'https://user:secret@api.example.com/v1', false],
  ['https://api.example.com/v1', 'https://api.example.com/v1#other', false],
  [undefined, 'https://api.example.com/v1', false],
])('saved endpoint %s and requested %s match only under allowed canonicalization', (saved, requested, expected) => {
  expect(sameCatalogueEndpoint(saved, requested as string)).toBe(expected);
});
