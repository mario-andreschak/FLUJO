import fs from 'node:fs';
import path from 'node:path';

/**
 * Issue #1389: only the flow page's route checked whether a Persona still used
 * a flow, and the MCP `delete_flow` tool deleted it anyway. A deleted flow that
 * a Persona, automation or other flow still uses leaves it pointing at nothing.
 * Server code deletes a flow a person or agent picked only through
 * `deleteFlowAndMoveUses` (src/backend/services/flow/flowDeletion.ts), which
 * moves every place first. The raw `flowService.deleteFlow` stays for the
 * places below, each of which removes a flow nothing else can know about yet.
 */
const SERVER_ROOTS = ['backend', 'app'].map((dir) => path.join(process.cwd(), 'src', dir));
const RAW_DELETE = /\bflowService\.deleteFlow\(|\bthis\.deleteFlow\(/;

const ALLOWED: Readonly<Record<string, string>> = {
  'src/backend/services/flow/flowDeletion.ts': 'the one entry: moves every place, then deletes',
  'src/backend/services/flow/index.ts': 'rolls back a child flow it created a moment earlier',
  'src/backend/services/enduringAgents/personaComposition.ts': 'rolls back a Persona copy it created a moment earlier',
  'src/backend/services/packages/installPackage.ts': 'uninstall removes the flows the package itself created',
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('one way to delete a flow someone picked', () => {
  it('server code deletes flows only through deleteFlowAndMoveUses', () => {
    const offenders = SERVER_ROOTS.flatMap(sourceFiles).flatMap((file) => {
      const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
      if (ALLOWED[relative]) return [];
      const text = fs.readFileSync(file, 'utf8');
      // Client pages call the browser flow service, which goes through the API route.
      if (!text.includes("from '@/backend/services/flow'") && !relative.startsWith('src/backend/services/flow/')) return [];
      return text.split(/\r?\n/).flatMap((line, index) => (RAW_DELETE.test(line)
        ? [`${relative}:${index + 1}: ${line.trim()}`]
        : []));
    });
    if (offenders.length > 0) {
      throw new Error('Delete a flow with deleteFlowAndMoveUses (src/backend/services/flow/flowDeletion.ts) so '
        + `Personas, automations and other flows that use it are moved first:\n${offenders.join('\n')}`);
    }
  });

  it('every allowed file still deletes flows, so the list only shrinks', () => {
    const stale = Object.keys(ALLOWED).filter((file) => !RAW_DELETE.test(fs.readFileSync(path.join(process.cwd(), file), 'utf8')));
    expect(stale).toEqual([]);
  });
});
