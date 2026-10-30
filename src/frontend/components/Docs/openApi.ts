/**
 * OpenAPI 3.1 export of FLUJO's curated API reference (#1278). The in-app
 * reference and the downloadable document are generated from the same
 * API_GROUPS data, so both stay standardized: every operation has a summary,
 * tagged group, path/query parameters, a request body schema for writes, and
 * a response description.
 */
import type { ApiEndpoint, ApiGroup, ApiParam } from './apiReference';

type Schema = Record<string, unknown>;
export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Map the reference's informal type strings onto JSON Schema. */
export function paramSchema(type: string): Schema {
  const normalized = type.trim().toLowerCase();
  if (/\|/.test(normalized) && /'[^']+'/.test(type)) {
    const values = [...type.matchAll(/'([^']+)'/g)].map(match => match[1]);
    if (values.length) return { type: 'string', enum: values };
  }
  if (normalized.endsWith('[]')) return { type: 'array', items: paramSchema(type.slice(0, -2)) };
  if (/^(string|uuid|id)\b/.test(normalized)) return { type: 'string' };
  if (/^(number|float|double)\b/.test(normalized)) return { type: 'number' };
  if (/^(integer|int)\b/.test(normalized)) return { type: 'integer' };
  if (/^(boolean|bool)\b/.test(normalized)) return { type: 'boolean' };
  if (/^(file|binary)\b/.test(normalized)) return { type: 'string', format: 'binary' };
  if (/^array\b/.test(normalized)) return { type: 'array', items: {} };
  return { type: 'object' };
}

/** `/v1/chat/{conversationId}#anchor?x` -> clean OpenAPI path and its path parameter names. */
export function openApiPath(path: string): { path: string; pathParams: string[] } {
  const clean = path.split('#')[0].split('?')[0];
  return { path: clean, pathParams: [...clean.matchAll(/\{([^}]+)\}/g)].map(match => match[1]) };
}

function objectSchema(params: readonly ApiParam[]): Schema {
  const required = params.filter(param => param.required).map(param => param.name);
  return {
    type: 'object',
    properties: Object.fromEntries(params.map(param => [param.name, { ...paramSchema(param.type), description: param.description }])),
    ...(required.length ? { required } : {}),
  };
}

export function operationFor(endpoint: ApiEndpoint, group: ApiGroup, method: string): Record<string, unknown> {
  const { pathParams } = openApiPath(endpoint.path);
  const params = endpoint.params ?? [];
  const inQuery = endpoint.paramsLabel === 'Query' || (!BODY_METHODS.has(method) && endpoint.paramsLabel !== 'Body' && endpoint.paramsLabel !== 'Form data');
  const parameters = [
    ...pathParams.map(name => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
    ...(inQuery ? params.filter(param => !pathParams.includes(param.name)).map(param => ({
      name: param.name, in: 'query', required: Boolean(param.required), description: param.description, schema: paramSchema(param.type),
    })) : []),
  ];
  const description = [endpoint.notes?.join('\n'), endpoint.details].filter(Boolean).join('\n\n') || undefined;
  let requestBody: Record<string, unknown> | undefined;
  if (BODY_METHODS.has(method) && !inQuery && endpoint.requestBody !== 'none') {
    const mediaType = endpoint.paramsLabel === 'Form data' ? 'multipart/form-data' : 'application/json';
    requestBody = { required: params.some(param => param.required), content: { [mediaType]: { schema: objectSchema(params) } } };
  }
  return {
    operationId: `${method.toLowerCase()}_${endpoint.path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}`,
    summary: endpoint.summary,
    tags: [group.name],
    ...(description ? { description } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: { default: { description: endpoint.response ?? 'See the operation summary.' } },
  };
}

export function buildOpenApiDocument(groups: readonly ApiGroup[], serverUrl: string, version: string): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  for (const group of groups) {
    for (const endpoint of group.endpoints) {
      const { path } = openApiPath(endpoint.path);
      for (const method of [endpoint.method, ...(endpoint.alsoMethods ?? [])]) {
        const item = paths[path] ??= {};
        const key = method.toLowerCase();
        if (!item[key]) item[key] = operationFor(endpoint, group, method);
      }
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'FLUJO API', version, description: 'Generated from the in-app API reference.' },
    servers: [{ url: serverUrl }],
    tags: groups.map(group => ({ name: group.name, description: group.description })),
    paths,
  };
}
