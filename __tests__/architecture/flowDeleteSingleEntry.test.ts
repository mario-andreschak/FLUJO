import fs from 'node:fs';
import path from 'node:path';

/**
 * Issue #1389: only the flow page's route checked whether a Persona still used
 * a flow, the MCP `delete_flow` tool deleted it anyway, deleting a Connected
 * App (MCP server) never checked at all, and package uninstall deleted both
 * without asking. Something deleted while a Persona, automation or flow still
 * uses it leaves that place pointing at nothing.
 *
 * Server code deletes a flow only through `deleteFlowAndMoveUses`
 * (src/backend/services/flow/flowDeletion.ts) and a Connected App only through
 * `deleteMcpServerAndMoveUses` (src/backend/services/mcp/serverDeletion.ts),
 * which move every place first. The raw removals stay for the places below,
 * each of which removes something nothing else can know about yet.
 *
 * Since #571 split the MCP service, the raw Connected App removal lives in
 * serverConfigUpdate.ts and `mcpService.deleteServerConfig` hands it over in
 * one call. Only the service may import that module, so the raw removal has
 * no way in other than `mcpService.deleteServerConfig`.
 */
const SERVER_ROOTS = ['backend', 'app'].map((dir) => path.join(process.cwd(), 'src', dir));

interface RawDelete {
  what: string;
  pattern: RegExp;
  /** Files that import the raw service, or live beside it. */
  reaches: (relative: string, text: string) => boolean;
  entry: string;
  allowed: Readonly<Record<string, string>>;
  /**
   * The module a split moved the raw removal into, the one service file that
   * may import it, and the single call there that hands the removal over.
   */
  owner?: { module: string; service: string; handOff: string };
}

const importsModule = (text: string, modulePath: string) => {
  const name = path.posix.basename(modulePath).replace(/\.tsx?$/, '');
  return new RegExp(`(?:from|import\\(|require\\()\\s*['"][^'"]*/${name}(?:\\.tsx?)?['"]`).test(text);
};

const RAW_DELETES: readonly RawDelete[] = [
  {
    what: 'flow',
    pattern: /\bflowService\.deleteFlow\(|\bthis\.deleteFlow\(/,
    // Client pages call the browser flow service, which goes through the API route.
    reaches: (relative, text) => text.includes("from '@/backend/services/flow'") || relative.startsWith('src/backend/services/flow/'),
    entry: 'deleteFlowAndMoveUses (src/backend/services/flow/flowDeletion.ts)',
    allowed: {
      'src/backend/services/flow/flowDeletion.ts': 'the one entry: moves every place, then deletes',
      'src/backend/services/flow/index.ts': 'rolls back a child flow it created a moment earlier',
      'src/backend/services/enduringAgents/personaComposition.ts': 'rolls back a Persona copy it created a moment earlier',
    },
  },
  {
    what: 'Connected App',
    pattern: /\.deleteServerConfig\(/,
    // Client pages call the browser MCP service, which goes through the API route.
    reaches: (relative, text) => text.includes("from '@/backend/services/mcp'") || relative.startsWith('src/backend/services/mcp/'),
    entry: 'deleteMcpServerAndMoveUses (src/backend/services/mcp/serverDeletion.ts)',
    allowed: {
      'src/backend/services/mcp/serverDeletion.ts': 'the one entry: moves every place, then deletes',
      'src/backend/services/mcp/directInstall.ts': 'rolls back a server it saved a moment earlier that offers no tools',
      'src/backend/services/mcp/registryInstall.ts': 'rolls back a server it installed a moment earlier that offers no tools',
    },
    owner: {
      module: 'src/backend/services/mcp/serverConfigUpdate.ts',
      service: 'src/backend/services/mcp/index.ts',
      handOff: 'return serverConfigUpdate.deleteServerConfig(this.configUpdateHost(), serverName);',
    },
  },
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const files = SERVER_ROOTS.flatMap(sourceFiles).map((file) => ({
  relative: path.relative(process.cwd(), file).split(path.sep).join('/'),
  text: fs.readFileSync(file, 'utf8'),
}));

describe.each(RAW_DELETES)('one way to delete a $what someone picked', (rule) => {
  it(`server code deletes a ${rule.what} only through its checked entry`, () => {
    const offenders = files.flatMap(({ relative, text }) => {
      if (rule.allowed[relative] || !rule.reaches(relative, text)) return [];
      return text.split(/\r?\n/).flatMap((line, index) => {
        const handOff = relative === rule.owner?.service && line.trim() === rule.owner.handOff;
        return rule.pattern.test(line) && !handOff ? [`${relative}:${index + 1}: ${line.trim()}`] : [];
      });
    });
    if (offenders.length > 0) {
      throw new Error(`Delete a ${rule.what} with ${rule.entry} so `
        + `Personas, automations and flows that use it are moved first:\n${offenders.join('\n')}`);
    }
  });

  it('every allowed file still uses the raw delete, so the list only shrinks', () => {
    const stale = Object.keys(rule.allowed).filter((file) => !rule.pattern.test(fs.readFileSync(path.join(process.cwd(), file), 'utf8')));
    expect(stale).toEqual([]);
  });

  const owner = rule.owner;
  if (!owner) return;

  it(`only the service reaches the module that holds the raw ${rule.what} removal, through one hand-off`, () => {
    const intruders = files
      .filter(({ relative, text }) => relative !== owner.service && relative !== owner.module && importsModule(text, owner.module))
      .map(({ relative }) => relative);
    if (intruders.length > 0) {
      throw new Error(`${owner.module} holds the raw ${rule.what} removal. Call ${rule.entry} instead of importing it, `
        + `so the places that use the ${rule.what} are moved first:\n${intruders.join('\n')}`);
    }
    const service = files.find(({ relative }) => relative === owner.service)?.text ?? '';
    const handOffs = service.split(/\r?\n/).filter((line) => line.trim() === owner.handOff);
    expect({ importsOwner: importsModule(service, owner.module), handOffs: handOffs.length }).toEqual({ importsOwner: true, handOffs: 1 });
  });
});

describe('the owner rule sees every way to import the module', () => {
  const ownerModule = 'src/backend/services/mcp/serverConfigUpdate.ts';

  it.each([
    ["import * as serverConfigUpdate from './serverConfigUpdate';", true],
    ["import { deleteServerConfig } from '@/backend/services/mcp/serverConfigUpdate';", true],
    ["} from \"../mcp/serverConfigUpdate.ts\";", true],
    ["const { deleteServerConfig } = await import('./serverConfigUpdate');", true],
    ["const update = require('./serverConfigUpdate');", true],
    ["import { saveConfig } from './serverConfigUpdates';", false],
    ["import { mcpService } from '@/backend/services/mcp';", false],
  ])('%s', (line, expected) => {
    expect(importsModule(line, ownerModule)).toBe(expected);
  });
});
