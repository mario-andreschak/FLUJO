import {
  PERSONA_CAPABILITY_AREAS,
  PERSONA_CAPABILITY_MANIFEST,
  PERSONA_UI_MAPPED_BACKEND_ENDPOINTS,
  PERSONA_UI_MAPPED_BACKEND_OPERATIONS,
} from '@/shared/types/enduringAgent';
import fs from 'fs';
import path from 'path';

const TECHNICAL_UI_JARGON = /\b(?:api|backend|database|schema|lease|fencing?|grant|revision id|identifier|slot key|persona tools?|capability intersection|autonomy enum)\b/i;

describe('Persona capability manifest', () => {
  it('maps every shipped backend operation to exactly one friendly UI area', () => {
    const operationOwner = new Map<string, string>();
    const endpointOwner = new Map<string, string>();
    const capabilityIds = new Set<string>();

    for (const capability of PERSONA_CAPABILITY_MANIFEST) {
      expect(capabilityIds.has(capability.id)).toBe(false);
      capabilityIds.add(capability.id);

      expect(PERSONA_CAPABILITY_AREAS).toContain(capability.ui.area);
      expect(capability.ui.label.trim()).not.toBe('');
      expect(capability.recovery.trim()).not.toBe('');
      expect(capability.backendOperations.length).toBeGreaterThan(0);
      expect(capability.backendEndpoints.length).toBeGreaterThan(0);
      expect(capability.ui.entryPoints.length).toBeGreaterThan(0);

      for (const userFacingText of [
        capability.name,
        capability.description,
        capability.ui.area,
        capability.ui.label,
        capability.recovery,
      ]) {
        expect(userFacingText).not.toMatch(TECHNICAL_UI_JARGON);
      }

      for (const operation of capability.backendOperations) {
        expect(operation).toMatch(/^[a-z][a-z-]*(?:\.[a-z][a-z-]*)+$/);
        expect(operationOwner.get(operation)).toBeUndefined();
        operationOwner.set(operation, capability.id);
      }

      for (const endpoint of capability.backendEndpoints) {
        expect(endpoint).toMatch(/^(?:GET|POST|PATCH|PUT|DELETE) \/(?:api|v1)\//);
        expect(endpointOwner.get(endpoint)).toBeUndefined();
        endpointOwner.set(endpoint, capability.id);
      }

      for (const entryPoint of capability.ui.entryPoints) {
        expect(fs.existsSync(path.join(process.cwd(), entryPoint))).toBe(true);
      }
    }

    expect([...operationOwner.keys()]).toEqual(PERSONA_UI_MAPPED_BACKEND_OPERATIONS);
    expect(new Set(PERSONA_UI_MAPPED_BACKEND_OPERATIONS).size)
      .toBe(PERSONA_UI_MAPPED_BACKEND_OPERATIONS.length);
    expect([...endpointOwner.keys()]).toEqual(PERSONA_UI_MAPPED_BACKEND_ENDPOINTS);
    expect(new Set(PERSONA_UI_MAPPED_BACKEND_ENDPOINTS).size)
      .toBe(PERSONA_UI_MAPPED_BACKEND_ENDPOINTS.length);
  });

  it('keeps every declared endpoint backed by a real route and method', () => {
    for (const endpoint of PERSONA_UI_MAPPED_BACKEND_ENDPOINTS) {
      const separator = endpoint.indexOf(' ');
      const method = endpoint.slice(0, separator);
      const url = endpoint.slice(separator + 1);
      const routeFile = path.join(process.cwd(), 'src', 'app', ...url.slice(1).split('/'), 'route.ts');

      expect(fs.existsSync(routeFile)).toBe(true);
      expect(fs.readFileSync(routeFile, 'utf8')).toMatch(
        new RegExp(`export const ${method}\\b`),
      );
    }
  });

  it('rejects a public Persona endpoint that has no UI-backed manifest entry', () => {
    const routeRoots = [
      path.join(process.cwd(), 'src', 'app', 'v1', 'personas'),
      path.join(process.cwd(), 'src', 'app', 'v1', 'persona-drafts'),
    ];

    const routeFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolutePath);
        else if (entry.name === 'route.ts') routeFiles.push(absolutePath);
      }
    };
    routeRoots.forEach(visit);

    const discovered = routeFiles.flatMap((routeFile) => {
      const routeDirectory = path.dirname(routeFile);
      const relativeRoute = path.relative(path.join(process.cwd(), 'src', 'app'), routeDirectory)
        .split(path.sep)
        .join('/');
      const source = fs.readFileSync(routeFile, 'utf8');
      return [...source.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\b/g)]
        .map((match) => `${match[1]} /${relativeRoute}`);
    }).sort();

    const declared = PERSONA_UI_MAPPED_BACKEND_ENDPOINTS
      .filter((endpoint) => /^\w+ \/v1\/(?:personas|persona-drafts)(?:\/|$)/.test(endpoint))
      .slice()
      .sort();

    expect(declared).toEqual(discovered);
  });
});
