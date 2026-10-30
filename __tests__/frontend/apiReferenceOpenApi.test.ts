import { API_GROUPS } from '@/frontend/components/Docs/apiReference';
import { buildOpenApiDocument, openApiPath, paramSchema } from '@/frontend/components/Docs/openApi';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const all = API_GROUPS.flatMap(group => group.endpoints.map(endpoint => ({ group, endpoint })));

describe('standardized API reference (#1278)', () => {
  it('documents every write with a typed request body or an explicit "no body"', () => {
    const undocumented = all
      .filter(({ endpoint }) => BODY_METHODS.has(endpoint.method) && endpoint.requestBody !== 'none'
        && endpoint.paramsLabel !== 'Query' && !(endpoint.params?.length))
      .map(({ endpoint }) => `${endpoint.method} ${endpoint.path}`);
    expect(undocumented).toEqual([]);
  });

  it('gives every endpoint a summary and a response description', () => {
    expect(all.filter(({ endpoint }) => !endpoint.summary?.trim()).map(({ endpoint }) => endpoint.path)).toEqual([]);
    expect(all.filter(({ endpoint }) => !endpoint.response?.trim()).map(({ endpoint }) => `${endpoint.method} ${endpoint.path}`)).toEqual([]);
  });

  it('exports a valid-shaped OpenAPI 3.1 document covering every operation', () => {
    const document = buildOpenApiDocument(API_GROUPS, 'http://localhost:4200', '0.0.0-test');
    expect(document.openapi).toBe('3.1.0');
    for (const { endpoint } of all) {
      const operation = document.paths[openApiPath(endpoint.path).path]?.[endpoint.method.toLowerCase()] as Record<string, unknown> | undefined;
      expect(operation).toBeDefined();
      expect(operation!.responses).toBeDefined();
      if (BODY_METHODS.has(endpoint.method) && endpoint.requestBody !== 'none' && endpoint.paramsLabel !== 'Query') {
        expect(operation!.requestBody).toBeDefined();
      }
    }
    const ids = Object.values(document.paths).flatMap(item => Object.values(item).map(operation => (operation as { operationId: string }).operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps informal types onto JSON Schema', () => {
    expect(paramSchema('string')).toEqual({ type: 'string' });
    expect(paramSchema('boolean')).toEqual({ type: 'boolean' });
    expect(paramSchema('string[]')).toEqual({ type: 'array', items: { type: 'string' } });
    expect(paramSchema("'a' | 'b'")).toEqual({ type: 'string', enum: ['a', 'b'] });
  });
});
